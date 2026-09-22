package com.nurichter.timelinerx;

import android.app.ActivityManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.WindowManager;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native side of TimelinerX for Android.
 *
 * Video sinks: the web layer streams the MP4 in positional chunks (the muxer patches the index at
 * the start at the end), so the file is written with RandomAccessFile into the app cache and only
 * then copied into the shared Movies/TimelinerX collection. Nothing is uploaded anywhere.
 */
@CapacitorPlugin(name = "TlxNative")
public class TlxNativePlugin extends Plugin {

    private static final String ALBUM = "TimelinerX";
    private final Map<String, RandomAccessFile> sinks = new HashMap<>();
    private final Map<String, File> sinkFiles = new HashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private JSObject pendingIncoming = null;
    private int nextId = 1;

    @Override
    public void load() {
        if (getActivity() != null) handleIncoming(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIncoming(intent);
    }

    // ------------------------------------------------------------------ device info
    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("release", Build.VERSION.RELEASE);
        r.put("model", Build.MODEL);
        r.put("manufacturer", Build.MANUFACTURER);
        try {
            ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            r.put("totalMemMB", mi.totalMem / (1024 * 1024));
            r.put("availMemMB", mi.availMem / (1024 * 1024));
            r.put("lowRam", am.isLowRamDevice());
            r.put("memoryClassMB", am.getLargeMemoryClass());
        } catch (Exception ignored) {}
        File dir = getContext().getCacheDir();
        r.put("cacheFreeMB", dir.getUsableSpace() / (1024 * 1024));
        call.resolve(r);
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    // ------------------------------------------------------------------ video sink
    private File exportDir() {
        File d = new File(getContext().getCacheDir(), "exports");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    @PluginMethod
    public void sinkOpen(PluginCall call) {
        String name = safeName(call.getString("name", "timelinerx.mp4"));
        try {
            File f = new File(exportDir(), name + ".part");
            if (f.exists()) f.delete();
            RandomAccessFile raf = new RandomAccessFile(f, "rw");
            String id;
            synchronized (sinks) {
                id = "s" + (nextId++);
                sinks.put(id, raf);
                sinkFiles.put(id, f);
            }
            JSObject r = new JSObject();
            r.put("id", id);
            r.put("path", f.getAbsolutePath());
            call.resolve(r);
        } catch (IOException e) {
            call.reject("Cannot create the video file: " + e.getMessage(), "io", e);
        }
    }

    @PluginMethod
    public void sinkWrite(PluginCall call) {
        final String id = call.getString("id");
        final Long position = call.getLong("position", 0L);
        final String data = call.getString("data", "");
        final RandomAccessFile raf;
        synchronized (sinks) { raf = sinks.get(id); }
        if (raf == null) { call.reject("Unknown sink", "sink"); return; }
        io.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                synchronized (raf) {
                    raf.seek(position == null ? 0L : position);
                    raf.write(bytes);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Writing the video failed (is the storage full?): " + e.getMessage(), "io", e);
            }
        });
    }

    @PluginMethod
    public void sinkAbort(PluginCall call) {
        String id = call.getString("id");
        RandomAccessFile raf;
        File f;
        synchronized (sinks) { raf = sinks.remove(id); f = sinkFiles.remove(id); }
        io.execute(() -> {
            try { if (raf != null) raf.close(); } catch (IOException ignored) {}
            if (f != null) f.delete();
            call.resolve();
        });
    }

    @PluginMethod
    public void sinkClose(PluginCall call) {
        final String id = call.getString("id");
        final String title = safeName(call.getString("title", "TimelinerX"));
        final boolean toGallery = Boolean.TRUE.equals(call.getBoolean("saveToGallery", true));
        final RandomAccessFile raf;
        final File part;
        synchronized (sinks) { raf = sinks.remove(id); part = sinkFiles.remove(id); }
        if (raf == null || part == null) { call.reject("Unknown sink", "sink"); return; }
        io.execute(() -> {
            try {
                raf.getFD().sync();
                raf.close();
                File done = new File(part.getParentFile(), title.endsWith(".mp4") ? title : title + ".mp4");
                if (done.exists()) done.delete();
                if (!part.renameTo(done)) throw new IOException("rename failed");
                JSObject r = new JSObject();
                r.put("path", done.getAbsolutePath());
                r.put("size", done.length());
                if (toGallery) {
                    Uri uri = copyToGallery(done, done.getName());
                    r.put("uri", uri.toString());
                }
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Saving the video failed: " + e.getMessage(), "io", e);
            }
        });
    }

    private Uri copyToGallery(File src, String displayName) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Video.Media.DISPLAY_NAME, displayName);
            v.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            v.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/" + ALBUM);
            v.put(MediaStore.Video.Media.IS_PENDING, 1);
            Uri collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri item = cr.insert(collection, v);
            if (item == null) throw new IOException("MediaStore refused the video");
            try (OutputStream out = cr.openOutputStream(item); InputStream in = new FileInputStream(src)) {
                if (out == null) throw new IOException("Cannot open the gallery item");
                copy(in, out);
            } catch (IOException e) {
                cr.delete(item, null, null);
                throw e;
            }
            v.clear();
            v.put(MediaStore.Video.Media.IS_PENDING, 0);
            cr.update(item, v, null, null);
            return item;
        }
        // Android 7 to 9: the app's own Movies folder, announced to the media scanner.
        File dir = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_MOVIES), ALBUM);
        if (!dir.exists()) dir.mkdirs();
        File dst = new File(dir, displayName);
        try (InputStream in = new FileInputStream(src); OutputStream out = new java.io.FileOutputStream(dst)) {
            copy(in, out);
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { dst.getAbsolutePath() }, new String[] { "video/mp4" }, null);
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", dst);
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }

    // ------------------------------------------------------------------ gallery items
    @PluginMethod
    public void share(PluginCall call) {
        String u = call.getString("uri");
        String path = call.getString("path");
        String mime = call.getString("mime", "video/mp4");
        try {
            Uri uri = u != null ? Uri.parse(u)
                : FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", new File(path));
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, call.getString("title", "TimelinerX"));
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Cannot share: " + e.getMessage(), "share", e);
        }
    }

    /** Small files made by the app (e.g. an exported .nrproj): written to the cache and shared. */
    @PluginMethod
    public void shareFile(PluginCall call) {
        final String name = safeName(call.getString("name", "file"));
        final String data = call.getString("data", "");
        final String mime = call.getString("mime", "application/octet-stream");
        io.execute(() -> {
            try {
                File f = new File(exportDir(), name);
                try (OutputStream out = new java.io.FileOutputStream(f)) { out.write(Base64.decode(data, Base64.DEFAULT)); }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, name);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(() -> getActivity().startActivity(chooser));
                call.resolve();
            } catch (Exception e) {
                call.reject("Cannot share the file: " + e.getMessage(), "share", e);
            }
        });
    }

    @PluginMethod
    public void openMedia(PluginCall call) {
        String u = call.getString("uri");
        String path = call.getString("path");
        try {
            Uri uri = u != null ? Uri.parse(u)
                : FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", new File(path));
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, call.getString("mime", "video/mp4"));
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(view);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can play this video: " + e.getMessage(), "open", e);
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url")));
            view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(view);
            call.resolve();
        } catch (Exception e) {
            call.reject("Cannot open the link", "open", e);
        }
    }

    @PluginMethod
    public void mediaExists(PluginCall call) {
        String u = call.getString("uri");
        boolean ok = false;
        if (u != null) {
            try (Cursor c = getContext().getContentResolver().query(Uri.parse(u), new String[] { OpenableColumns.SIZE }, null, null, null)) {
                ok = c != null && c.moveToFirst();
            } catch (Exception ignored) {}
        }
        JSObject r = new JSObject();
        r.put("exists", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void deleteMedia(PluginCall call) {
        String u = call.getString("uri");
        int n = 0;
        try {
            if (u != null) n = getContext().getContentResolver().delete(Uri.parse(u), null, null);
        } catch (SecurityException e) {
            call.reject("Android did not allow deleting this video. Delete it from the Gallery.", "denied", e);
            return;
        } catch (Exception ignored) {}
        JSObject r = new JSObject();
        r.put("deleted", n > 0);
        call.resolve(r);
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String path = call.getString("path");
        boolean ok = false;
        if (path != null) {
            File f = new File(path);
            File base = getContext().getCacheDir();
            try {
                if (f.getCanonicalPath().startsWith(base.getCanonicalPath())) ok = f.delete();
            } catch (IOException ignored) {}
        }
        JSObject r = new JSObject();
        r.put("deleted", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void clearExports(PluginCall call) {
        File[] files = exportDir().listFiles();
        int n = 0;
        if (files != null) for (File f : files) if (f.delete()) n++;
        JSObject r = new JSObject();
        r.put("deleted", n);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ incoming Timeline files
    @PluginMethod
    public void consumeIncoming(PluginCall call) {
        JSObject r = new JSObject();
        synchronized (this) {
            r.put("file", pendingIncoming);
            pendingIncoming = null;
        }
        call.resolve(r);
    }

    private void handleIncoming(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(action)) {
            Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) uri = (Uri) extra;
        }
        if (uri == null) return;
        final Uri src = uri;
        intent.setAction(Intent.ACTION_MAIN);
        io.execute(() -> {
            try {
                String name = displayName(src);
                File dir = new File(getContext().getCacheDir(), "incoming");
                if (!dir.exists()) dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                File dst = new File(dir, safeName(name));
                try (InputStream in = getContext().getContentResolver().openInputStream(src);
                     OutputStream out = new java.io.FileOutputStream(dst)) {
                    if (in == null) return;
                    copy(in, out);
                }
                JSObject f = new JSObject();
                f.put("path", dst.getAbsolutePath());
                f.put("name", name);
                f.put("size", dst.length());
                synchronized (this) { pendingIncoming = f; }
                notifyListeners("incomingFile", f, true);
            } catch (Exception e) {
                JSObject f = new JSObject();
                f.put("error", String.valueOf(e.getMessage()));
                notifyListeners("incomingFile", f, true);
            }
        });
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {}
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null ? "Timeline.json" : name;
    }

    private static String safeName(String s) {
        if (s == null || s.trim().isEmpty()) return "timelinerx";
        String out = s.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (out.length() > 120) out = out.substring(0, 120);
        return out.toLowerCase(Locale.ROOT).startsWith(".") ? "_" + out : out;
    }
}
