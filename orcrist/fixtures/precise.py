try:
    import tomllib
except ImportError:
    pass


def load(path: str, options: Options):
    if options is None:
        return
    try:
        read(path)
    except OSError:
        ...
    if path is None:
        return
