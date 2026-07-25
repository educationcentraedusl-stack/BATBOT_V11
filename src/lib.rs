#[macro_use]
extern crate napi_derive;

pub mod lob;
pub mod ws;

use lob::LimitOrderBook;

#[napi]
pub fn init_core() -> String {
    "BATBOT_V11_CORE_INITIALIZED".to_string()
}

#[napi]
pub fn create_lob_engine() -> bool {
    let mut lob = LimitOrderBook::new();
    let bids = [(100.0, 1.5); 20];
    let asks = [(100.5, 2.0); 20];
    lob.update_depth(&bids, &asks, 1_000_000);
    lob.metrics.obi != 0.0
}
