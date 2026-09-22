// Transport modes (port of timeline/modes.py).
export const Mode = { UNKNOWN: 0, WALK: 1, CYCLE: 2, ROAD: 3, RAIL: 4, WATER: 5, FLIGHT: 6 };
const TYPES = {
  1: ['WALKING', 'ON_FOOT', 'RUNNING', 'HIKING', 'WALKING_NORDIC'],
  2: ['CYCLING', 'IN_BICYCLE', 'MOTORCYCLING', 'IN_MOTORCYCLE', 'SKATEBOARDING', 'SKIING', 'SNOWBOARDING'],
  3: ['IN_PASSENGER_VEHICLE', 'IN_VEHICLE', 'DRIVING', 'IN_CAR', 'IN_TAXI', 'IN_BUS', 'IN_ROAD_VEHICLE', 'IN_FOUR_WHEELER'],
  4: ['IN_TRAIN', 'IN_SUBWAY', 'IN_TRAM', 'IN_RAIL_VEHICLE', 'IN_CABLECAR', 'IN_FUNICULAR'],
  5: ['IN_FERRY', 'SAILING', 'BOATING', 'IN_BOAT', 'KAYAKING', 'ROWING', 'SURFING', 'SWIMMING', 'IN_CRUISE_SHIP'],
  6: ['FLYING', 'IN_AIRPLANE', 'IN_PLANE', 'IN_HELICOPTER'],
};
const LOOKUP = new Map();
for (const [m, ts] of Object.entries(TYPES)) for (const t of ts) LOOKUP.set(t, Number(m));

export const FLIGHT_MIN_KM = 150.0;
export const FLIGHT_MIN_KMH = 250.0;
export const ARC_MIN_KM = 80.0;

export function modeFromType(t) {
  if (typeof t !== 'string') return Mode.UNKNOWN;
  return LOOKUP.get(t.trim().toUpperCase()) ?? Mode.UNKNOWN;
}

export function inferFlight(distanceKm, seconds) {
  if (distanceKm < FLIGHT_MIN_KM || seconds <= 0) return false;
  return distanceKm / (seconds / 3600) >= FLIGHT_MIN_KMH;
}

export const MODE_KEYS = ['unknown', 'walk', 'cycle', 'road', 'rail', 'water', 'flight'];
