light = lambda beacon, keeper: send(beacon, keeper)
process = lambda signal: signal.strip()

light("amon-din", "Hirgon")
light("eilenach", "Hirgon")

shout = lambda word: word.strip().upper().replace(" ", "_").replace("-", "_") + "!"
yell = lambda phrase: phrase.strip().upper().replace(" ", "_").replace("-", "_") + "!"
