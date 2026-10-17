pub struct Disk;

impl Store for Disk {
    fn save(&self, text: &str) {}
}

pub fn beacon_id(title: &str) -> String {
    let small = title.trim().to_lowercase();
    let dashed = small.split(' ').collect::<Vec<_>>().join("-");
    dashed.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "")
}
