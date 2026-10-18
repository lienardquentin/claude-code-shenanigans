fn save(path: &str) {
    if let Err(_) = fs::write(path, "lit") {}
    if let Err(error) = fs::write(path, "lit") {
        report(error);
    }
}
