<?php
declare(strict_types=1);

// Converts a KML document (as extracted from a KMZ, or a raw .kml upload) into
// a GeoJSON FeatureCollection array, ready for json_encode(). Generalized for
// standard Google Earth / Google My Maps exports — resolves Style/StyleMap
// definitions rather than guessing colors from naming conventions, and walks
// arbitrarily nested Folder/Document structures.

const KML_MAX_PLACEMARKS   = 5000;
const KML_MAX_COORD_PAIRS  = 20000;
const KML_MAX_BYTES        = 20 * 1024 * 1024;

function parse_kml_to_geojson(string $kmlXml): array {
    if (strlen($kmlXml) > KML_MAX_BYTES) {
        throw new RuntimeException('KML file is too large');
    }
    // Defense in depth against XXE, on top of libxml's entity loading being
    // disabled by default since libxml2 2.9 / PHP 8.
    if (preg_match('/<!DOCTYPE|<!ENTITY/i', $kmlXml)) {
        throw new RuntimeException('KML file contains disallowed DOCTYPE/ENTITY declarations');
    }

    $dom = new DOMDocument();
    $dom->formatOutput = false;
    $prevErrors = libxml_use_internal_errors(true);
    $ok = $dom->loadXML($kmlXml, LIBXML_NONET);
    libxml_clear_errors();
    libxml_use_internal_errors($prevErrors);
    if (!$ok) {
        throw new RuntimeException('Could not parse KML XML');
    }

    [$styles, $styleMaps] = _kml_collect_styles($dom);

    $state = ['coordPairs' => 0, 'placemarks' => 0];
    $features = [];
    foreach ($dom->getElementsByTagName('Placemark') as $placemark) {
        $feature = _kml_placemark_to_feature($placemark, $styles, $styleMaps, $state);
        if ($feature !== null) $features[] = $feature;
    }

    return ['type' => 'FeatureCollection', 'features' => $features];
}

// ─── Styles ─────────────────────────────────────────────────────────────────

function _kml_collect_styles(DOMDocument $dom): array {
    $styles = [];
    foreach ($dom->getElementsByTagName('Style') as $styleEl) {
        $id = $styleEl->getAttribute('id');
        if ($id === '') continue;
        $styles[$id] = _kml_style_from_element($styleEl);
    }

    $styleMaps = [];
    foreach ($dom->getElementsByTagName('StyleMap') as $mapEl) {
        $id = $mapEl->getAttribute('id');
        if ($id === '') continue;
        foreach ($mapEl->getElementsByTagName('Pair') as $pair) {
            $key = _kml_child_text($pair, 'key');
            if ($key !== 'normal') continue;
            $url = _kml_child_text($pair, 'styleUrl');
            if ($url !== null) $styleMaps[$id] = ltrim($url, '#');
        }
    }

    return [$styles, $styleMaps];
}

function _kml_style_from_element(DOMElement $styleEl): array {
    $props = [
        'stroke'         => '#555555',
        'stroke-opacity' => 1.0,
        'stroke-width'   => 1.5,
        'fill'           => '#555555',
        'fill-opacity'   => 0.15,
    ];

    foreach ($styleEl->getElementsByTagName('LineStyle') as $lineStyle) {
        $color = _kml_child_text($lineStyle, 'color');
        if ($color !== null) {
            [$hex, $alpha] = _kml_color_to_rgba($color);
            $props['stroke']         = $hex;
            $props['stroke-opacity'] = $alpha;
        }
        $width = _kml_child_text($lineStyle, 'width');
        if ($width !== null && is_numeric($width)) $props['stroke-width'] = (float)$width;
        break; // direct child only
    }

    foreach ($styleEl->getElementsByTagName('PolyStyle') as $polyStyle) {
        $color = _kml_child_text($polyStyle, 'color');
        if ($color !== null) {
            [$hex, $alpha] = _kml_color_to_rgba($color);
            $props['fill']         = $hex;
            $props['fill-opacity'] = $alpha;
        }
        break;
    }

    return $props;
}

// KML color is aabbggrr hex. Returns ['#rrggbb', alpha 0..1].
function _kml_color_to_rgba(string $kmlColor): array {
    $c = strtolower(trim($kmlColor));
    if (!preg_match('/^[0-9a-f]{8}$/', $c)) return ['#555555', 1.0];
    $aa = hexdec(substr($c, 0, 2));
    $bb = substr($c, 2, 2);
    $gg = substr($c, 4, 2);
    $rr = substr($c, 6, 2);
    return ['#' . $rr . $gg . $bb, round($aa / 255, 3)];
}

// ─── Placemarks ─────────────────────────────────────────────────────────────

function _kml_placemark_to_feature(DOMElement $placemark, array $styles, array $styleMaps, array &$state): ?array {
    $state['placemarks']++;
    if ($state['placemarks'] > KML_MAX_PLACEMARKS) {
        throw new RuntimeException('KML file has too many placemarks');
    }

    $geometry = _kml_placemark_geometry($placemark, $state);
    if ($geometry === null) return null;

    $name = _kml_child_text($placemark, 'name');
    $name = ($name !== null && trim($name) !== '') ? trim($name) : null;

    $styleId = _kml_child_text($placemark, 'styleUrl');
    $styleId = $styleId !== null ? ltrim($styleId, '#') : null;
    if ($styleId !== null && isset($styleMaps[$styleId])) $styleId = $styleMaps[$styleId];
    $style = ($styleId !== null && isset($styles[$styleId])) ? $styles[$styleId] : _kml_style_from_element($placemark);

    $properties = $style;
    if ($name !== null) $properties['name'] = $name;

    return ['type' => 'Feature', 'properties' => $properties, 'geometry' => $geometry];
}

// Only considers direct children of the Placemark, so nested Placemarks
// (shouldn't exist per spec, but be defensive) don't get double-counted.
function _kml_placemark_geometry(DOMElement $placemark, array &$state): ?array {
    foreach ($placemark->childNodes as $child) {
        if (!$child instanceof DOMElement) continue;
        $geom = _kml_element_to_geometry($child, $state);
        if ($geom !== null) return $geom;
    }
    return null;
}

function _kml_element_to_geometry(DOMElement $el, array &$state): ?array {
    switch ($el->tagName) {
        case 'Point':
            $coords = _kml_coordinates($el, $state, 1);
            return $coords ? ['type' => 'Point', 'coordinates' => $coords[0]] : null;

        case 'LineString':
            $coords = _kml_coordinates($el, $state);
            return $coords ? ['type' => 'LineString', 'coordinates' => $coords] : null;

        case 'Polygon':
            $rings = [];
            foreach ($el->getElementsByTagName('outerBoundaryIs') as $outer) {
                $ring = _kml_ring($outer, $state);
                if ($ring) $rings[] = $ring;
                break;
            }
            if (!$rings) return null;
            foreach ($el->getElementsByTagName('innerBoundaryIs') as $inner) {
                $ring = _kml_ring($inner, $state);
                if ($ring) $rings[] = $ring;
            }
            return ['type' => 'Polygon', 'coordinates' => $rings];

        case 'MultiGeometry':
            $geoms = [];
            foreach ($el->childNodes as $child) {
                if (!$child instanceof DOMElement) continue;
                $g = _kml_element_to_geometry($child, $state);
                if ($g !== null) $geoms[] = $g;
            }
            return $geoms ? ['type' => 'GeometryCollection', 'geometries' => $geoms] : null;

        default:
            return null;
    }
}

function _kml_ring(DOMElement $boundary, array &$state): ?array {
    foreach ($boundary->getElementsByTagName('LinearRing') as $ring) {
        $coords = _kml_coordinates($ring, $state);
        return $coords ?: null;
    }
    return null;
}

// Reads the first direct/descendant <coordinates> text under $el and parses
// "lon,lat[,alt] lon,lat[,alt] ..." into [[lon, lat], ...], dropping altitude.
function _kml_coordinates(DOMElement $el, array &$state, ?int $limit = null): ?array {
    $coordEls = $el->getElementsByTagName('coordinates');
    if ($coordEls->length === 0) return null;
    $text = trim($coordEls->item(0)->textContent);
    if ($text === '') return null;

    $pairs = [];
    foreach (preg_split('/\s+/', $text) as $tuple) {
        if ($tuple === '') continue;
        $parts = explode(',', $tuple);
        if (count($parts) < 2 || !is_numeric($parts[0]) || !is_numeric($parts[1])) continue;

        $state['coordPairs']++;
        if ($state['coordPairs'] > KML_MAX_COORD_PAIRS) {
            throw new RuntimeException('KML file has too many coordinate points');
        }

        $pairs[] = [round((float)$parts[0], 6), round((float)$parts[1], 6)];
        if ($limit !== null && count($pairs) >= $limit) break;
    }

    return $pairs ?: null;
}

function _kml_child_text(DOMElement $el, string $tag): ?string {
    foreach ($el->childNodes as $child) {
        if ($child instanceof DOMElement && $child->tagName === $tag) {
            return $child->textContent;
        }
    }
    return null;
}
