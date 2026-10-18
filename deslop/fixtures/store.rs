pub trait Store {
    fn save(&self, text: &str);
}

pub fn slug_of(name: &str) -> String {
    let lowered = name.trim().to_lowercase();
    let joined = lowered.split(' ').collect::<Vec<_>>().join("-");
    joined.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "")
}
