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
