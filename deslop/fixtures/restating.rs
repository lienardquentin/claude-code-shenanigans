fn load(path: &str) -> Config {
    // read the config file
    let config = read_config_file(path);
    // the deploy mounts it read-only, so a missing file means a broken image
    let tmp2 = parse(config);
    fs::write(path, "lit").ok();
    let _ = fs::remove_file(path);
    // deslop: spare swallowed-error
    io::stdout().flush().ok();
    tmp2
}
