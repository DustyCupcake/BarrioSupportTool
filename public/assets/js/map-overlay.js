/**
 * Renders the current site map overlay (structures/containers/barrio
 * footprints traced from an uploaded KMZ/KML) onto a Leaflet map as a
 * non-interactive reference layer, so it never intercepts clicks meant for
 * markers or the map itself.
 *
 * Assumes the global `L` from the Leaflet <script> tag is already loaded on
 * the page, matching the existing map modules (fill_route.js, fill-route.js).
 */

export async function renderSiteOverlay(map) {
  let data;
  try {
    const res = await fetch('/api/map-overlay', { credentials: 'include' });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  if (!data.present || !data.geojson) return null;

  // eslint-disable-next-line no-undef
  return L.geoJSON(data.geojson, {
    interactive: false,
    style: feature => ({
      color:       feature.properties?.stroke ?? '#555555',
      weight:      feature.properties?.['stroke-width']   ?? 1.5,
      opacity:     feature.properties?.['stroke-opacity'] ?? 1,
      fillColor:   feature.properties?.fill ?? '#555555',
      fillOpacity: feature.properties?.['fill-opacity']   ?? 0.15,
    }),
  }).addTo(map);
}
