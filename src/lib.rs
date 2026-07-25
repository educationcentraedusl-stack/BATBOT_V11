#[macro_use]
extern crate napi_derive;

#[napi]
pub fn init_core() -> String {
    "BATBOT_V11_CORE_INITIALIZED".to_string()
}
