def handle_data(info, path: str, mode: str | None = None):
    # write the path
    write_path(path)
    try:
        save(path, mode)
    except OSError:
        pass
    if not isinstance(path, str):
        raise TypeError(path)
    try:
        serve()
    except KeyboardInterrupt:
        pass
