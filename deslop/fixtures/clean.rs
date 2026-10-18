/// The beacons a chain lights, in order.
pub fn lit(chain: &[Beacon]) -> Vec<&str> {
    chain.iter().filter(|beacon| beacon.lit).map(|beacon| beacon.name.as_str()).collect()
}
