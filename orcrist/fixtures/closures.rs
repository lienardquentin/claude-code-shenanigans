fn signals(beacons: &[&str]) -> Vec<String> {
    let slug_of = |name: &str| {
        let lowered = name.trim().to_lowercase();
        let joined = lowered.split(' ').collect::<Vec<_>>().join("-");
        joined.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "")
    };
    let beacon_id = |title: &str| {
        let small = title.trim().to_lowercase();
        let dashed = small.split(' ').collect::<Vec<_>>().join("-");
        dashed.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "")
    };
    let handle = |beacon: &str| beacon.len();
    beacons.iter().map(|beacon| slug_of(beacon) + &beacon_id(beacon) + &handle(beacon).to_string()).collect()
}

fn weights(beacons: &[&str]) -> Vec<usize> {
    let measure = |beacon| {
        let trimmed = str::trim(beacon);
        let words = trimmed.split(' ').count();
        words * trimmed.len() + words
    };
    let weigh = |signal| {
        let trimmed = str::trim(signal);
        let words = trimmed.split(' ').count();
        words * trimmed.len() + words
    };
    beacons.iter().map(|beacon| measure(beacon) + weigh(beacon)).collect()
}
