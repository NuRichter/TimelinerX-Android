// Bundled fonts (OFL): Outfit for display text, Instrument Sans for UI text and map labels.
const FACES = [
  ['Outfit', 'Outfit-Regular.ttf', '400'], ['Outfit', 'Outfit-Bold.ttf', '700'],
  ['Instrument Sans', 'InstrumentSans-Regular.ttf', '400'], ['Instrument Sans', 'InstrumentSans-Bold.ttf', '600 700'],
];
let loaded = null;
export function loadFonts(base = './fonts/') {
  if (loaded) return loaded;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return (loaded = Promise.resolve());
  loaded = Promise.all(FACES.map(async ([family, file, weight]) => {
    try {
      const f = new FontFace(family, `url(${base}${file})`, { weight, display: 'block' });
      await f.load();
      document.fonts.add(f);
    } catch (e) { console.warn('font', file, e); }
  }));
  return loaded;
}
