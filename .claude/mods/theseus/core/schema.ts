// The JSON Schema of .claude/theseus.toml, for editors that check a TOML file against one (Taplo, Even Better TOML).
// schema/theseus.schema.json is written from it by `sh .claude/mods/kit/write-schema.sh`; a test holds its keys to
// the ones core/config.ts reads.

export const SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/lienardquentin/theseus/main/theseus/schema/theseus.schema.json",
  "title": "Theseus project file (.claude/theseus.toml)",
  "description": "What Theseus proves and reviews a change by. See docs/config.md.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "review": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "The slash commands that review a settled change, in turn: \"/code-review medium\"."
    },
    "standards": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Files of written standards the reviewers judge a change by, from the project's folder."
    },
    "targets": {
      "type": "object",
      "description": "Each thing the project builds, by its name.",
      "additionalProperties": {
        "$ref": "#/$defs/target"
      }
    }
  },
  "$defs": {
    "target": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "kind",
        "roots"
      ],
      "properties": {
        "kind": {
          "enum": [
            "cli",
            "service",
            "frontend"
          ],
          "description": "cli: a command-line tool whose runs the recorder keeps; service: an HTTP app played in-process; frontend: proved by its own tests."
        },
        "roots": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1,
          "description": "The folders whose edits are edits of this target."
        },
        "tests": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "The files and folders that hold its integration tests."
        },
        "test": {
          "type": "string",
          "description": "Runs the named tests from the project's folder, naming each as it ends; {tests} is filled with the tests a change marks."
        },
        "app": {
          "type": "string",
          "description": "A service's app as Python imports it: \"module:app\"."
        },
        "python": {
          "type": "string",
          "description": "A service's Python folder: put on the path, and its uv project when it has one."
        },
        "env": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "description": "What a service is played with, the same on both builds."
        },
        "masks": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Regular expressions, as Python reads them: what each matches in an answer is left out of a comparison."
        },
        "requests": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "A service's kept requests, played in order: \"GET /health\", 'POST /path {\"json\": 1}'."
        },
        "affected": {
          "type": "string",
          "description": "Runs every test a change of this target can break."
        },
        "checks": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Lint, type and format checks a change may not newly fail; {against} is the commit compared with."
        },
        "audit": {
          "type": "string",
          "description": "Audits its dependencies, when a change touches a dependency manifest."
        },
        "db": {
          "$ref": "#/$defs/db"
        },
        "ready": {
          "$ref": "#/$defs/ready"
        },
        "live": {
          "$ref": "#/$defs/live"
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "service"
              }
            }
          },
          "then": {
            "required": [
              "app"
            ]
          }
        }
      ]
    },
    "db": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "image"
      ],
      "description": "A Postgres each build plays against, in a warm container.",
      "properties": {
        "image": {
          "type": "string",
          "description": "A Postgres image: \"postgres:18-alpine\"."
        },
        "env": {
          "type": "string",
          "description": "The variable its address is set in; DATABASE_URL when not said."
        },
        "setup": {
          "type": "string",
          "description": "Run before a build plays, its address set: a migration."
        }
      }
    },
    "ready": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "request"
      ],
      "description": "Asked before a service is played, until it answers.",
      "properties": {
        "request": {
          "type": "string",
          "description": "\"GET /health\""
        },
        "match": {
          "type": "string",
          "description": "A regular expression its body must match."
        }
      }
    },
    "live": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "workload"
      ],
      "description": "Where the service is deployed, to play both builds against its real dependencies.",
      "properties": {
        "workload": {
          "type": "string",
          "description": "context/namespace/kind/name; a context naming prod is refused."
        },
        "forward": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "service:port reached by port-forward."
        },
        "env": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "description": "Laid over the workload's variables."
        },
        "db": {
          "type": "string",
          "description": "The database's workload in the same namespace: deployment/postgres."
        },
        "before": {
          "type": "string"
        },
        "cleanup": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "restore": {
          "type": "string"
        },
        "scratch": {
          "type": "string",
          "description": "The variable each build's copy of the deployed database is set in."
        }
      }
    }
  }
} as const
