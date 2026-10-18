class Tower:
    def kindle(self, keeper):
        send(self, keeper)


def watch(tower):
    def kindle(beacon, keeper):
        send(beacon, keeper)

    kindle("min-rimmon", "Hirgon")
    kindle("calenhad", "Hirgon")
    tower.kindle("Denethor")
    tower.kindle("Denethor")
