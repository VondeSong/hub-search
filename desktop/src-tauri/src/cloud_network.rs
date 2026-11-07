//! Device-local reading network policy. The native snapshot is read before each OSS request.
use super::*;
const KEY: &str = "reading_cloud_network";
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    #[default]
    Any,
    Unmetered,
    Wifi,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Network {
    supported: bool,
    #[serde(default)]
    connected: Option<bool>,
    kind: String,
    #[serde(default)]
    metered: Option<bool>,
    restricted: bool,
}
impl Network {
    fn unknown(supported: bool) -> Self {
        Self {
            supported,
            connected: None,
            kind: "unknown".into(),
            metered: None,
            restricted: false,
        }
    }
}
pub(crate) fn policy(c: &Connection) -> Result<Mode, String> {
    match metadata_string(c, KEY).as_str() {
        "" | "any" => Ok(Mode::Any),
        "unmetered" => Ok(Mode::Unmetered),
        "wifi" => Ok(Mode::Wifi),
        _ => Err("阅读网络设置损坏，请重新保存".into()),
    }
}
fn save(c: &Connection, mode: Mode) -> Result<(), String> {
    let name = match mode {
        Mode::Any => "any",
        Mode::Unmetered => "unmetered",
        Mode::Wifi => "wifi",
    };
    c.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![KEY,name]).map(|_|()).map_err(|e|e.to_string())
}
fn permit(mode: Mode, n: &Network) -> Result<(), String> {
    if n.connected == Some(false) {
        return Err("阅读传输已暂停：当前没有可用的互联网连接".into());
    }
    if mode == Mode::Any {
        return Ok(());
    }
    if !n.supported || n.connected != Some(true) || n.metered.is_none() {
        return Err("阅读传输已暂停：无法确认当前网络，请连接允许的网络或调整阅读网络策略".into());
    }
    if n.metered != Some(false) || n.restricted {
        return Err("阅读传输已暂停：当前为计费网络或系统限制流量，已保留待同步内容".into());
    }
    if mode == Mode::Wifi && n.kind != "wifi" {
        return Err("阅读传输已暂停：当前无法确认为非计费 Wi-Fi".into());
    }
    Ok(())
}
#[cfg(windows)]
fn native(_app: Option<&AppHandle>) -> Network {
    use windows::Networking::Connectivity::{
        NetworkConnectivityLevel, NetworkCostType, NetworkInformation,
    };
    let read = || -> windows::core::Result<Network> {
        let profile = NetworkInformation::GetInternetConnectionProfile()?;
        let cost = profile.GetConnectionCost()?;
        let cost_type = cost.NetworkCostType()?;
        let extra = cost.Roaming()? || cost.OverDataLimit()? || cost.ApproachingDataLimit()?;
        Ok(Network {
            supported: true,
            connected: Some(
                profile.GetNetworkConnectivityLevel()? == NetworkConnectivityLevel::InternetAccess,
            ),
            kind: if profile.IsWwanConnectionProfile()? {
                "cellular"
            } else if profile.IsWlanConnectionProfile()? {
                "wifi"
            } else {
                // The remaining profiles can include VPN/virtual adapters, not only Ethernet.
                "other"
            }
            .into(),
            metered: if extra {
                Some(true)
            } else if cost_type == NetworkCostType::Unknown {
                None
            } else {
                Some(cost_type != NetworkCostType::Unrestricted)
            },
            restricted: false,
        })
    };
    read().unwrap_or_else(|_| Network::unknown(true))
}
#[cfg(target_os = "android")]
fn native(app: Option<&AppHandle>) -> Network {
    app.and_then(|app| app.try_state::<AndroidSourceOpener>())
        .and_then(|plugin| {
            plugin
                .0
                .run_mobile_plugin::<Network>("readingNetworkState", json!({}))
                .ok()
        })
        .unwrap_or_else(|| Network::unknown(true))
}
#[cfg(not(any(windows, target_os = "android")))]
fn native(_app: Option<&AppHandle>) -> Network {
    Network::unknown(false)
}
pub(crate) fn guard(
    app: AppHandle,
    mode: Mode,
) -> std::sync::Arc<dyn Fn() -> Result<(), String> + Send + Sync> {
    std::sync::Arc::new(move || permit(mode, &native(Some(&app))))
}
fn status(app: &AppHandle, mode: Mode) -> Value {
    let network = native(Some(app));
    let reason = permit(mode, &network).err();
    json!({"mode":mode,"network":network,"allowed":reason.is_none(),"reason":reason.unwrap_or_default()})
}
#[tauri::command]
pub(crate) async fn get_reading_network_policy(app: AppHandle) -> Result<Value, String> {
    let c = open_database(&database_path(&app)?)?;
    Ok(status(&app, policy(&c)?))
}
#[tauri::command]
pub(crate) async fn update_reading_network_policy(
    app: AppHandle,
    mode: Mode,
) -> Result<Value, String> {
    let _guard = reading_sync::LOCK.lock().await;
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    save(&c, mode)?;
    Ok(status(&app, policy(&c)?))
}
#[cfg(test)]
mod tests;
