//! WASAPI device access.

use crate::wire::Format;
use wasapi::{AudioClient, Device, DeviceEnumerator, Direction, SampleType, WaveFormat};

pub type Res<T> = Result<T, Box<dyn std::error::Error>>;

pub fn com_init() -> Res<()> {
    wasapi::initialize_mta().ok()?;
    Ok(())
}

pub fn to_format(w: &WaveFormat) -> Res<Format> {
    Ok(Format {
        float: matches!(w.get_subformat()?, SampleType::Float),
        bits: w.get_bitspersample(),
        valid_bits: w.get_validbitspersample(),
        rate: w.get_samplespersec(),
        channels: w.get_nchannels(),
        mask: w.get_dwchannelmask(),
    })
}

pub fn to_waveformat(f: &Format) -> WaveFormat {
    let st = if f.float { SampleType::Float } else { SampleType::Int };
    WaveFormat::new(f.bits as usize, f.valid_bits as usize, &st, f.rate as usize, f.channels as usize, Some(f.mask))
}

/// The device with this endpoint id, or the default one for the direction.
pub fn open(direction: Direction, id: Option<&str>) -> Res<Device> {
    let e = DeviceEnumerator::new()?;
    Ok(match id {
        Some(id) => e.get_device(id)?,
        None => e.get_default_device(&direction)?,
    })
}

pub fn mix_format(client: &AudioClient) -> Res<Format> {
    to_format(&client.get_mixformat()?)
}

fn describe(direction: Direction) -> Res<Vec<serde_json::Value>> {
    let e = DeviceEnumerator::new()?;
    let default_id = e.get_default_device(&direction).ok().and_then(|d| d.get_id().ok());
    let coll = e.get_device_collection(&direction)?;
    let mut out = Vec::new();
    for i in 0..coll.get_nbr_devices()? {
        let d = coll.get_device_at_index(i)?;
        let id = d.get_id()?;
        let name = d.get_friendlyname().unwrap_or_else(|_| "Unknown device".into());
        let mix = d.get_iaudioclient().ok().and_then(|c| mix_format(&c).ok()).map(|f| f.to_json());
        out.push(serde_json::json!({
            "id": id,
            "name": name,
            "isDefault": default_id.as_deref() == Some(id.as_str()),
            "mix": mix,
        }));
    }
    Ok(out)
}

pub fn list() -> Res<serde_json::Value> {
    Ok(serde_json::json!({
        "event": "devices",
        "playback": describe(Direction::Render)?,
        "capture": describe(Direction::Capture)?,
    }))
}

/// Makes these endpoints Windows' default devices, for every role (default and communications),
/// as Settings → Sound does. Each id is a playback or a recording endpoint.
///
/// Windows has no public API for this. Sound settings use the undocumented IPolicyConfig, which
/// has been stable since Windows 7: IUnknown's three methods, ten more, then SetDefaultEndpoint.
pub fn set_default(ids: &[String]) -> Res<()> {
    use std::ffi::c_void;
    use windows::Win32::Media::Audio::{ERole, eCommunications, eConsole, eMultimedia};
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
    use windows::core::{GUID, HRESULT, IUnknown, Interface, PCWSTR};

    const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const IID_POLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
    const SET_DEFAULT_ENDPOINT: usize = 13;
    type SetDefaultEndpoint = unsafe extern "system" fn(*mut c_void, PCWSTR, ERole) -> HRESULT;

    unsafe {
        let unknown: IUnknown = CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL)?;
        let mut raw = std::ptr::null_mut();
        unknown.query(&IID_POLICY_CONFIG, &mut raw).ok()?;
        // Owns the reference query added, and releases it on return.
        let policy = IUnknown::from_raw(raw);
        let vtable = *(policy.as_raw() as *const *const usize);
        let set: SetDefaultEndpoint = std::mem::transmute(*vtable.add(SET_DEFAULT_ENDPOINT));
        for id in ids {
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            for role in [eConsole, eMultimedia, eCommunications] {
                set(policy.as_raw(), PCWSTR(wide.as_ptr()), role).ok()?;
            }
        }
    }
    Ok(())
}
