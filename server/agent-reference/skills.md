# Skills

Skills are files under the server user's home that every agent on the box can run as `/name`. The Skills page and these routes show them per engine, in the order that engine resolves a name.

Use `GET /api/skills` for the catalog. Each engine lists its skills with `name`, `description`, `source` (`isomux` built in, `user` home folder, `project` agent working folder, `plugin` Claude Code plugin), `path`, `editable`, `uses` (your manager's slash-command uses), and `shadowedBy` when another skill with the same name runs instead. User skills follow your manager; project skills come from agents in rooms your manager can access.

Read a listed file with `GET /api/skills/file?path=<path>`. It returns the full SKILL.md and a `rev`. Save with `PUT /api/skills/file` and `{path,content,expectedRev}`, where `expectedRev` is the `rev` you read. Create a user skill with `POST /api/skills` and `{name,description,instructions?}`; it goes in the catalog's `newSkillDir`, the office's Claude skills folder. Saving and creating need editor access, as the editor panel's save does: members, privileged agents and API tokens have it; an ordinary agent's token gets 403.

Built-in and plugin skills are read-only. A new or saved skill reaches every agent's skill menu at once; a typed `/name` always runs the file as it is on disk.

Safe example: `GET /api/skills`.

## Route contract

| Method and route        | Request                                           | Success                                  |
| ----------------------- | ------------------------------------------------- | ---------------------------------------- |
| `GET /api/skills`       | None                                              | `{engines:[{engine,skills}],newSkillDir}` |
| `GET /api/skills/file`  | Query `path`                                      | `{path,content,rev,mtime,editable}`      |
| `PUT /api/skills/file`  | `{path,content,expectedRev}`                      | `{path,rev,mtime}`                       |
| `POST /api/skills`      | `{name,description,instructions?}`                | `201 {path,content,rev,mtime,editable}`  |

A path the catalog does not list returns 404 `skill_not_found`; a save to a read-only skill returns 403 `read_only`. A save whose `expectedRev` is older than the file on disk returns 409 `stale` with `currentRev`: read the file again, merge, and save. A file deleted on disk drops out of the catalog, so its save returns 404 `skill_not_found`; 409 `deleted` comes only when it goes during the save. A name that is not 1-64 lowercase letters, digits and single hyphens returns 422 `invalid_name`; a description that is empty, longer than 1024 characters or more than one line returns 422 `invalid_description`. An existing skill folder returns 409 `skill_exists`. A file over 1 MB returns 413.
