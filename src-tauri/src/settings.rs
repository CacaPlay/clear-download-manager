use super::*;

pub(crate) const WINDOW_BEHAVIOR_SETTINGS_KEY: &str = "window_behavior_v1";
pub(crate) const PREPARATION_WINDOW_SETTINGS_KEY: &str = "preparation_window_v1";
pub(crate) const EXPERIENCE_SETTINGS_KEY: &str = "experience_v1";
const APPEARANCE_SETTINGS_KEY: &str = "appearance_v2";
const LEGACY_APPEARANCE_SETTINGS_KEY: &str = "appearance_v1";

fn default_media_output_mode() -> String {
    "video_mp4".into()
}

fn default_playlist_format() -> String {
    "MP3 320 kbps".into()
}

fn default_appearance_preset() -> String {
    "cyan".into()
}

fn default_appearance_accent() -> String {
    "#24b8e8".into()
}

fn default_progress_active() -> String {
    "#00ff2a".into()
}

fn default_progress_completed() -> String {
    "#00ff2a".into()
}

fn default_progress_paused() -> String {
    "#e2a93f".into()
}

fn default_progress_error() -> String {
    "#ef6674".into()
}

fn default_icon_color_mode() -> String {
    "custom".into()
}

fn default_icon_color() -> String {
    "#596574".into()
}

fn previous_default_icon_color() -> &'static str {
    "#bbc7d4"
}

fn default_appearance_tone() -> u8 {
    8
}

fn default_appearance_intensity() -> u8 {
    82
}

fn default_appearance_contrast() -> u8 {
    108
}

fn default_appearance_surface_mode() -> String {
    "mica".into()
}

fn default_appearance_radius() -> String {
    "soft".into()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparationWindowGeometry {
    #[serde(default)]
    pub(crate) width: u32,
    #[serde(default)]
    pub(crate) height: u32,
    #[serde(default)]
    pub(crate) x: Option<i32>,
    #[serde(default)]
    pub(crate) y: Option<i32>,
    #[serde(default)]
    pub(crate) maximized: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparationWindowSettings {
    #[serde(default)]
    pub(crate) main: PreparationWindowGeometry,
    #[serde(default)]
    pub(crate) player: PreparationWindowGeometry,
    #[serde(default)]
    pub(crate) media: PreparationWindowGeometry,
    #[serde(default)]
    pub(crate) playlist: PreparationWindowGeometry,
    #[serde(default)]
    pub(crate) http: PreparationWindowGeometry,
    #[serde(default = "default_media_output_mode")]
    pub(crate) media_output_mode: String,
    #[serde(default)]
    pub(crate) media_format_selector: String,
    #[serde(default = "default_playlist_format")]
    pub(crate) playlist_format: String,
}

impl Default for PreparationWindowSettings {
    fn default() -> Self {
        Self {
            main: PreparationWindowGeometry::default(),
            player: PreparationWindowGeometry::default(),
            media: PreparationWindowGeometry::default(),
            playlist: PreparationWindowGeometry::default(),
            http: PreparationWindowGeometry::default(),
            media_output_mode: default_media_output_mode(),
            media_format_selector: String::new(),
            playlist_format: default_playlist_format(),
        }
    }
}

impl PreparationWindowSettings {
    pub(crate) fn validate(mut self) -> Self {
        if !matches!(
            self.media_output_mode.trim(),
            "video_mp4" | "video_webm" | "audio_best" | "audio_mp3" | "audio_m4a"
        ) {
            self.media_output_mode = default_media_output_mode();
        } else {
            self.media_output_mode = self.media_output_mode.trim().to_string();
        }
        self.media_format_selector = self
            .media_format_selector
            .trim()
            .chars()
            .take(240)
            .collect();
        self.playlist_format = self.playlist_format.trim().chars().take(80).collect();
        if self.playlist_format.is_empty() {
            self.playlist_format = default_playlist_format();
        }
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperienceSettings {
    #[serde(default = "default_clipboard_auto_suggest")]
    pub(crate) clipboard_auto_suggest: bool,
    #[serde(default = "default_receive_news")]
    pub(crate) receive_news: bool,
    #[serde(default = "default_automatic_update_checks")]
    pub(crate) automatic_update_checks: bool,
    #[serde(default = "default_show_extension_recommendation")]
    pub(crate) show_extension_recommendation: bool,
    #[serde(default)]
    pub(crate) extension_prompt_decision: String,
    #[serde(default)]
    pub(crate) news_read_ids: Vec<String>,
    #[serde(default)]
    pub(crate) news_dismissed_ids: Vec<String>,
    #[serde(default)]
    pub(crate) update_seen_versions: Vec<String>,
    #[serde(default)]
    pub(crate) pending_update_version: String,
    #[serde(default)]
    pub(crate) news_cache_json: String,
    #[serde(default)]
    pub(crate) news_cache_source: String,
    #[serde(default)]
    pub(crate) news_cache_etag: String,
    #[serde(default)]
    pub(crate) news_cache_last_modified: String,
    #[serde(default)]
    pub(crate) news_cache_fetched_at: i64,
    #[serde(default)]
    pub(crate) last_update_check_at: i64,
    #[serde(default)]
    pub(crate) locale: String,
    #[serde(default)]
    pub(crate) installed_update_history: Vec<serde_json::Value>,
    #[serde(default)]
    pub(crate) dismissed_history_ids: Vec<String>,
}

fn default_clipboard_auto_suggest() -> bool {
    true
}

fn default_receive_news() -> bool {
    true
}

fn default_automatic_update_checks() -> bool {
    true
}

fn default_show_extension_recommendation() -> bool {
    true
}

impl Default for ExperienceSettings {
    fn default() -> Self {
        Self {
            clipboard_auto_suggest: default_clipboard_auto_suggest(),
            receive_news: default_receive_news(),
            automatic_update_checks: default_automatic_update_checks(),
            show_extension_recommendation: default_show_extension_recommendation(),
            extension_prompt_decision: String::new(),
            news_read_ids: Vec::new(),
            news_dismissed_ids: Vec::new(),
            update_seen_versions: Vec::new(),
            pending_update_version: String::new(),
            news_cache_json: String::new(),
            news_cache_source: String::new(),
            news_cache_etag: String::new(),
            news_cache_last_modified: String::new(),
            news_cache_fetched_at: 0,
            last_update_check_at: 0,
            locale: "system".to_string(),
            installed_update_history: Vec::new(),
            dismissed_history_ids: Vec::new(),
        }
    }
}

impl ExperienceSettings {
    pub(crate) fn validate(mut self) -> Self {
        if !matches!(
            self.extension_prompt_decision.trim(),
            "" | "accepted" | "declined"
        ) {
            self.extension_prompt_decision.clear();
        } else {
            self.extension_prompt_decision = self.extension_prompt_decision.trim().to_string();
        }
        self.news_read_ids = self
            .news_read_ids
            .into_iter()
            .filter_map(|value| {
                let value = value.trim().to_string();
                (!value.is_empty() && value.chars().count() <= 120).then_some(value)
            })
            .take(128)
            .collect();
        self.news_dismissed_ids = self
            .news_dismissed_ids
            .into_iter()
            .filter_map(|value| {
                let value = value.trim().to_string();
                (!value.is_empty() && value.chars().count() <= 120).then_some(value)
            })
            .take(64)
            .collect();
        self.update_seen_versions = self
            .update_seen_versions
            .into_iter()
            .filter_map(|value| {
                let value = value.trim().to_string();
                (!value.is_empty() && value.chars().count() <= 80).then_some(value)
            })
            .take(32)
            .collect();
        self.pending_update_version = self
            .pending_update_version
            .trim()
            .chars()
            .take(80)
            .collect();
        self.news_cache_json = self.news_cache_json.chars().take(256 * 1024).collect();
        self.news_cache_source = self.news_cache_source.trim().chars().take(120).collect();
        self.news_cache_etag = self.news_cache_etag.trim().chars().take(300).collect();
        self.news_cache_last_modified = self
            .news_cache_last_modified
            .trim()
            .chars()
            .take(120)
            .collect();
        self.news_cache_fetched_at = self.news_cache_fetched_at.max(0);
        self.last_update_check_at = self.last_update_check_at.max(0);
        if !matches!(
            self.locale.trim().to_ascii_lowercase().as_str(),
            "system" | "es" | "en"
        ) {
            self.locale = "system".to_string();
        } else {
            self.locale = self.locale.trim().to_ascii_lowercase();
        }
        self.installed_update_history = self
            .installed_update_history
            .into_iter()
            .filter(|value| value.is_object())
            .take(32)
            .collect();
        self.dismissed_history_ids = self
            .dismissed_history_ids
            .into_iter()
            .filter_map(|value| {
                let value = value.trim().to_string();
                (!value.is_empty() && value.chars().count() <= 120).then_some(value)
            })
            .take(32)
            .collect();
        self
    }
}

pub(crate) fn read_experience_settings(connection: &Connection) -> ExperienceSettings {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![EXPERIENCE_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<ExperienceSettings>(&json).ok())
        .map(ExperienceSettings::validate)
        .unwrap_or_default()
}

pub(crate) fn persist_experience_settings(
    connection: &Connection,
    settings: &ExperienceSettings,
) -> Result<ExperienceSettings, String> {
    let settings = settings.clone().validate();
    let serialized = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            params![EXPERIENCE_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(settings)
}

pub(crate) fn read_preparation_window_settings(
    connection: &Connection,
) -> PreparationWindowSettings {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![PREPARATION_WINDOW_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<PreparationWindowSettings>(&json).ok())
        .map(PreparationWindowSettings::validate)
        .unwrap_or_default()
}

pub(crate) fn persist_preparation_window_settings(
    connection: &Connection,
    settings: &PreparationWindowSettings,
) -> Result<(), String> {
    let serialized =
        serde_json::to_string(&settings.clone().validate()).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            params![PREPARATION_WINDOW_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod preparation_window_tests {
    use super::*;

    #[test]
    fn preparation_window_preferences_round_trip_through_sqlite() {
        let connection = Connection::open_in_memory().expect("sqlite in-memory");
        connection
            .execute(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)",
                [],
            )
            .expect("settings table");
        let expected = PreparationWindowSettings {
            main: PreparationWindowGeometry::default(),
            player: PreparationWindowGeometry::default(),
            media: PreparationWindowGeometry {
                width: 1240,
                height: 760,
                x: Some(80),
                y: Some(60),
                maximized: false,
            },
            playlist: PreparationWindowGeometry {
                width: 1480,
                height: 860,
                x: Some(120),
                y: Some(90),
                maximized: false,
            },
            http: PreparationWindowGeometry::default(),
            media_output_mode: "audio_mp3".into(),
            media_format_selector: "bestaudio/best".into(),
            playlist_format: "MP3 320 kbps".into(),
        };
        persist_preparation_window_settings(&connection, &expected).expect("persist settings");
        assert_eq!(read_preparation_window_settings(&connection), expected);
    }

    #[test]
    fn invalid_preparation_output_mode_recovers_to_mp4() {
        let settings = PreparationWindowSettings {
            media_output_mode: "unsupported".into(),
            ..PreparationWindowSettings::default()
        }
        .validate();
        assert_eq!(settings.media_output_mode, "video_mp4");
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct CurrencySnapshot {
    pub(crate) rate: Option<f64>,
    pub(crate) source: String,
    pub(crate) updated_at: Option<String>,
    pub(crate) mode: String,
    pub(crate) online: bool,
    pub(crate) error: Option<String>,
}

fn default_ui_scale() -> u8 {
    100
}

fn default_auto_scale() -> bool {
    false
}

fn default_text_scale() -> u8 {
    100
}

fn default_theme() -> String {
    "system".into()
}

fn default_appearance_revision() -> u8 {
    0
}

fn default_density() -> String {
    "normal".into()
}

fn default_thumbnail_size() -> String {
    "large".into()
}

pub(crate) fn default_close_action() -> String {
    "tray".into()
}

fn default_minimize_action() -> String {
    "taskbar".into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowBehaviorSettings {
    #[serde(default = "default_close_action")]
    pub(crate) close_action: String,
    #[serde(default = "default_minimize_action")]
    pub(crate) minimize_action: String,
}

impl Default for WindowBehaviorSettings {
    fn default() -> Self {
        Self {
            close_action: default_close_action(),
            minimize_action: default_minimize_action(),
        }
    }
}

impl WindowBehaviorSettings {
    pub(crate) fn validate(self) -> Result<Self, String> {
        let close_action = self.close_action.trim().to_ascii_lowercase();
        let minimize_action = self.minimize_action.trim().to_ascii_lowercase();
        if !matches!(close_action.as_str(), "tray" | "exit") {
            return Err("El comportamiento al cerrar no es válido".into());
        }
        if minimize_action != "taskbar" {
            return Err("Minimizar debe conservar la aplicación en la barra de tareas".into());
        }
        Ok(Self {
            close_action,
            minimize_action,
        })
    }
}

pub(crate) fn read_window_behavior_settings(connection: &Connection) -> WindowBehaviorSettings {
    let value = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![WINDOW_BEHAVIOR_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    value
        .and_then(|json| serde_json::from_str::<WindowBehaviorSettings>(&json).ok())
        .and_then(|settings| settings.validate().ok())
        .unwrap_or_default()
}

pub(crate) fn persist_window_behavior_settings(
    connection: &Connection,
    settings: &WindowBehaviorSettings,
) -> Result<(), String> {
    let serialized = serde_json::to_string(settings).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            params![WINDOW_BEHAVIOR_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppearanceSettings {
    #[serde(default = "default_theme")]
    pub(crate) theme: String,
    #[serde(default = "default_appearance_preset")]
    pub(crate) preset: String,
    #[serde(default = "default_appearance_accent")]
    pub(crate) accent: String,
    #[serde(default = "default_progress_active")]
    pub(crate) progress_active: String,
    #[serde(default = "default_progress_completed")]
    pub(crate) progress_completed: String,
    #[serde(default = "default_progress_paused")]
    pub(crate) progress_paused: String,
    #[serde(default = "default_progress_error")]
    pub(crate) progress_error: String,
    #[serde(default)]
    pub(crate) progress_active_customized: bool,
    #[serde(default)]
    pub(crate) progress_completed_customized: bool,
    #[serde(default = "default_icon_color_mode")]
    pub(crate) icon_color_mode: String,
    #[serde(default = "default_icon_color")]
    pub(crate) icon_color: String,
    #[serde(default = "default_appearance_tone")]
    pub(crate) tone: u8,
    #[serde(default = "default_appearance_intensity")]
    pub(crate) intensity: u8,
    #[serde(default = "default_appearance_contrast")]
    pub(crate) contrast: u8,
    #[serde(default = "default_ui_scale")]
    pub(crate) scale: u8,
    #[serde(default = "default_auto_scale")]
    pub(crate) auto_scale: bool,
    #[serde(default = "default_text_scale")]
    pub(crate) text_scale: u8,
    #[serde(default = "default_density")]
    pub(crate) density: String,
    #[serde(default = "default_thumbnail_size")]
    pub(crate) thumbnail_size: String,
    #[serde(default)]
    pub(crate) motion: bool,
    #[serde(default)]
    pub(crate) motion_mode: String,
    #[serde(default = "default_appearance_surface_mode")]
    pub(crate) surface_mode: String,
    #[serde(default = "default_appearance_radius")]
    pub(crate) radius: String,
    #[serde(default)]
    pub(crate) revision: u64,
    #[serde(default = "default_appearance_revision")]
    pub(crate) appearance_revision: u8,
}

impl AppearanceSettings {
    pub(crate) fn validate(self) -> Result<Self, String> {
        let accent = self.accent.trim().to_ascii_lowercase();
        let valid_accent = accent.len() == 7
            && accent.starts_with('#')
            && accent
                .chars()
                .skip(1)
                .all(|character| character.is_ascii_hexdigit());
        if !valid_accent {
            return Err("El color de acento no es válido".into());
        }
        for (label, value) in [
            ("activo", &self.progress_active),
            ("completado", &self.progress_completed),
            ("pausa", &self.progress_paused),
            ("error", &self.progress_error),
        ] {
            let valid = value.len() == 7
                && value.starts_with('#')
                && value
                    .chars()
                    .skip(1)
                    .all(|character| character.is_ascii_hexdigit());
            if !valid {
                return Err(format!("El color de progreso {label} no es válido"));
            }
        }
        let icon_color = self.icon_color.trim().to_ascii_lowercase();
        let valid_icon_color = icon_color.len() == 7
            && icon_color.starts_with('#')
            && icon_color
                .chars()
                .skip(1)
                .all(|character| character.is_ascii_hexdigit());
        if !valid_icon_color {
            return Err("El color de iconos no es válido".into());
        }
        let icon_color_mode = self.icon_color_mode.trim().to_ascii_lowercase();
        if !matches!(icon_color_mode.as_str(), "accent" | "custom") {
            return Err("El modo de color de iconos no es válido".into());
        }
        let theme = self.theme.trim().to_ascii_lowercase();
        if !matches!(theme.as_str(), "dark" | "light" | "system") {
            return Err("El tema de apariencia no es válido".into());
        }
        if !(4..=18).contains(&self.tone)
            || !(40..=100).contains(&self.intensity)
            || !(86..=116).contains(&self.contrast)
            || !(50..=130).contains(&self.scale)
            || !self.scale.is_multiple_of(5)
            || !(80..=120).contains(&self.text_scale)
            || !self.text_scale.is_multiple_of(5)
        {
            return Err("Uno de los ajustes de apariencia está fuera de rango".into());
        }
        let density = match self.density.trim().to_ascii_lowercase().as_str() {
            "normal" => "balanced".to_string(),
            "comfortable" => "spacious".to_string(),
            value => value.to_string(),
        };
        let thumbnail_size = self.thumbnail_size.trim().to_ascii_lowercase();
        if !matches!(density.as_str(), "compact" | "balanced" | "spacious")
            || !matches!(thumbnail_size.as_str(), "medium" | "large" | "xlarge")
        {
            return Err("La densidad o el tamaño de miniaturas no es válido".into());
        }
        let motion_mode = match self.motion_mode.trim().to_ascii_lowercase().as_str() {
            "system" | "reduced" | "off" => self.motion_mode.trim().to_ascii_lowercase(),
            _ if self.motion => "system".into(),
            _ => "off".into(),
        };
        let surface_mode = self.surface_mode.trim().to_ascii_lowercase();
        if !matches!(surface_mode.as_str(), "solid" | "mica") {
            return Err("La superficie de apariencia no es válida".into());
        }
        let radius = self.radius.trim().to_ascii_lowercase();
        if !matches!(radius.as_str(), "sharp" | "standard" | "soft") {
            return Err("El radio de apariencia no es válido".into());
        }
        Ok(Self {
            theme,
            preset: self.preset.chars().take(48).collect(),
            accent,
            progress_active: self.progress_active.trim().to_ascii_lowercase(),
            progress_completed: self.progress_completed.trim().to_ascii_lowercase(),
            progress_paused: self.progress_paused.trim().to_ascii_lowercase(),
            progress_error: self.progress_error.trim().to_ascii_lowercase(),
            progress_active_customized: self.progress_active_customized,
            progress_completed_customized: self.progress_completed_customized,
            icon_color_mode,
            icon_color,
            tone: self.tone,
            intensity: self.intensity,
            contrast: self.contrast,
            scale: self.scale,
            auto_scale: self.auto_scale,
            text_scale: self.text_scale,
            density,
            thumbnail_size,
            motion: motion_mode != "off",
            motion_mode,
            surface_mode,
            radius,
            revision: self.revision,
            appearance_revision: 11,
        })
    }
}

fn migrate_appearance(mut appearance: AppearanceSettings) -> AppearanceSettings {
    if appearance.appearance_revision < 11 {
        if !appearance.progress_active_customized
            && appearance.progress_active.eq_ignore_ascii_case("#24b8e8")
        {
            appearance.progress_active = "#00ff2a".into();
        }
        if !appearance.progress_completed_customized
            && appearance
                .progress_completed
                .eq_ignore_ascii_case("#24b8e8")
        {
            appearance.progress_completed = "#00ff2a".into();
        }
        let icon_color_is_previous_default = appearance
            .icon_color
            .eq_ignore_ascii_case(previous_default_icon_color());
        if appearance.icon_color_mode != "custom" || icon_color_is_previous_default {
            appearance.icon_color_mode = default_icon_color_mode();
            appearance.icon_color = default_icon_color();
        }
        appearance.appearance_revision = 11;
    }
    appearance
}

pub(crate) fn read_appearance_settings(
    connection: &Connection,
) -> Result<Option<AppearanceSettings>, String> {
    let read_key = |key: &str| -> Result<Option<String>, String> {
        connection
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    };
    if let Some(json) = read_key(APPEARANCE_SETTINGS_KEY)? {
        let appearance =
            serde_json::from_str::<AppearanceSettings>(&json).map_err(|error| error.to_string())?;
        let needs_migration = appearance.appearance_revision < 11;
        let migrated = migrate_appearance(appearance);
        let normalized = migrated.clone().validate()?;
        if needs_migration {
            let serialized =
                serde_json::to_string(&normalized).map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE settings SET value=?1,updated_at=CURRENT_TIMESTAMP WHERE key=?2",
                    params![serialized, APPEARANCE_SETTINGS_KEY],
                )
                .map_err(|error| error.to_string())?;
        }
        return Ok(Some(normalized));
    }
    let Some(json) = read_key(LEGACY_APPEARANCE_SETTINGS_KEY)? else {
        return Ok(None);
    };
    let migrated = migrate_appearance(
        serde_json::from_str::<AppearanceSettings>(&json).map_err(|error| error.to_string())?,
    )
    .validate()?;
    let serialized = serde_json::to_string(&migrated).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO NOTHING",
            params![APPEARANCE_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(Some(migrated))
}

pub(crate) fn persist_appearance_settings(
    connection: &Connection,
    appearance: AppearanceSettings,
) -> Result<AppearanceSettings, String> {
    let mut appearance = appearance.validate()?;
    let previous_revision: u64 = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![APPEARANCE_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .and_then(|json| serde_json::from_str::<AppearanceSettings>(&json).ok())
        .map(|value| value.revision)
        .unwrap_or(0);
    appearance.revision = previous_revision.saturating_add(1);
    let json = serde_json::to_string(&appearance).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
            params![APPEARANCE_SETTINGS_KEY, json],
        )
        .map_err(|error| error.to_string())?;
    Ok(appearance)
}

fn setting_value(connection: &Connection, key: &str) -> Option<String> {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

pub(crate) fn read_currency_snapshot(connection: &Connection) -> CurrencySnapshot {
    let current: Option<(String, String)> = connection
        .query_row(
            "SELECT value,updated_at FROM settings WHERE key='usd_dop_rate'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    if let Some((value, updated_at)) = current {
        if let Ok(rate) = value.parse::<f64>() {
            let source = setting_value(connection, "usd_dop_source")
                .unwrap_or_else(|| "Última tasa guardada".into());
            let mode = setting_value(connection, "usd_dop_mode").unwrap_or_else(|| "cached".into());
            return CurrencySnapshot {
                rate: Some(rate),
                source,
                updated_at: Some(updated_at),
                online: mode == "live",
                mode,
                error: None,
            };
        }
    }

    let legacy: Option<(String, String)> = connection
        .query_row(
            "SELECT value,updated_at FROM settings WHERE key='manual_usd_dop_rate'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    if let Some((value, updated_at)) = legacy {
        if let Ok(rate) = value.parse::<f64>() {
            return CurrencySnapshot {
                rate: Some(rate),
                source: "Tasa manual local".into(),
                updated_at: Some(updated_at),
                mode: "manual".into(),
                online: false,
                error: None,
            };
        }
    }

    CurrencySnapshot {
        rate: None,
        source: "Sin tasa configurada".into(),
        updated_at: None,
        mode: "missing".into(),
        online: false,
        error: None,
    }
}

pub(crate) fn get_appearance_settings(
    state: State<'_, LocalState>,
) -> Result<Option<AppearanceSettings>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    settings::read_appearance_settings(&connection)
    /*
        let value: Option<String> = connection
            .query_row(
                "SELECT value FROM settings WHERE key='appearance_v1'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        value
            .map(|json| {
                serde_json::from_str::<AppearanceSettings>(&json).map_err(|error| error.to_string())
            })
            .transpose()
    }

    */
}
pub(crate) fn save_appearance_settings(
    appearance: AppearanceSettings,
    state: State<'_, LocalState>,
) -> Result<AppearanceSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    settings::persist_appearance_settings(&connection, appearance)
    /*
        let appearance = appearance.validate()?;
        let json = serde_json::to_string(&appearance).map_err(|error| error.to_string())?;
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        connection
            .execute(
                "INSERT INTO settings(key,value,updated_at) VALUES('appearance_v1',?1,CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
                params![json],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    */
}
pub(crate) fn window_behavior_settings(
    state: State<'_, LocalState>,
) -> Result<WindowBehaviorSettings, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    Ok(settings::read_window_behavior_settings(&connection))
    /*
        state
            .window_behavior
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "No se pudo leer el comportamiento de la ventana".to_string())
    }

    */
}
pub(crate) fn save_window_behavior_settings(
    settings: WindowBehaviorSettings,
    state: State<'_, LocalState>,
) -> Result<WindowBehaviorSettings, String> {
    let settings = settings.validate()?;
    {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        settings::persist_window_behavior_settings(&connection, &settings)?;
    }
    let mut current = state
        .window_behavior
        .lock()
        .map_err(|_| "No se pudo actualizar el comportamiento de la ventana".to_string())?;
    *current = settings.clone();
    Ok(settings)
    /*
    let settings = settings.validate()?;
    let serialized = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "No se pudo bloquear la base local".to_string())?;
        connection
            .execute(
                "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
                params![WINDOW_BEHAVIOR_SETTINGS_KEY, serialized],
            )
            .map_err(|error| error.to_string())?;
    }
    let mut current = state
        .window_behavior
        .lock()
        .map_err(|_| "No se pudo actualizar el comportamiento de la ventana".to_string())?;
    *current = settings.clone();
    Ok(settings)
    */
}
