import sys
from pathlib import Path

# The realms are packages beside this folder, not installed ones
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
