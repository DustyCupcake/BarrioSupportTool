-- Adds the site map overlay table: a per-event KMZ/KML site plan (structures,
-- containers, barrio footprints) rendered as a reference layer on the Fill
-- Route maps. Singleton in practice — the app deletes any existing row before
-- inserting a new upload.

CREATE TABLE IF NOT EXISTS map_overlays (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name          VARCHAR(255) NOT NULL,
    geojson       LONGTEXT     NOT NULL,
    feature_count INT UNSIGNED NOT NULL DEFAULT 0,
    uploaded_by   INT UNSIGNED NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_map_overlay_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
