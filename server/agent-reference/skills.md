# Skills

Skills are files under the server user's home that every agent on the box can run as `/name`. These routes list them per engine, in the order that engine resolves a name. The Skills page shows a file once in All agents when its name and path are present and unshadowed in all three engine catalogs; the engine tabs show the remaining entries. Each catalog retains its existing rule: a file runs if any agent context on that engine runs it. Different symlink paths remain separate. The read-only Commands tab uses the office command registry and the descriptions from /help, with aliases grouped under their command.

Use `GET /api/skills` for the catalog. Each engine lists its skills with `name`, `description`, `source` (`isomux` built in, `user` home folder, `project` agent working folder, `plugin` Claude Code plugin), `path`, `editable`, `uses` (your manager's slash-command uses), and `shadowedBy` when another skill with the same name runs instead. User skills follow your manager; project skills come from agents in rooms your manager can access.

Read a listed file with `GET /api/skills/file?path=<path>`. It returns the full SKILL.md and a `rev`. Save with `PUT /api/skills/file` and `{path,content,expectedRev}`, where `expectedRev` is the `rev` you read. Create a user skill with `POST /api/skills` and `{name,description,instructions?}`; it goes in the catalog's `newSkillDir`, the office's Claude skills folder. Saving, deleting and creating need editor access, as the editor panel's save does: members, privileged agents and API tokens have it; an ordinary agent's token gets 403.

Built-in and plugin skills are read-only. A new or saved skill reaches every agent's skill menu at once; a typed `/name` always runs the file as it is on disk.

SKILL.md saves require closed, valid YAML front matter with nonempty text `name` and `description` fields. The name may differ from the folder. A failed check returns 422 `invalid_skill` with a message that names the problem and leaves the file unchanged. Legacy command `.md` saves have no front matter validation. Files edited elsewhere remain in the catalog, and the page shows any format problem so the file can be repaired.

Safe example: `GET /api/skills`.

## Route contract

| Method and route          | Request                            | Success                                   |
| ------------------------- | ---------------------------------- | ----------------------------------------- |
| `GET /api/skills`         | None                               | `{engines:[{engine,skills}],newSkillDir}` |
| `GET /api/skills/file`    | Query `path`                       | `{path,content,rev,mtime,editable}`       |
| `PUT /api/skills/file`    | `{path,content,expectedRev}`       | `{path,rev,mtime}`                        |
| `DELETE /api/skills/file` | `{path,expectedRev}`               | `204`                                     |
| `POST /api/skills`        | `{name,description,instructions?}` | `201 {path,content,rev,mtime,editable}`   |

A path the catalog does not list returns 404 `skill_not_found`; a save to a read-only skill returns 403 `read_only`. A save whose `expectedRev` is older than the file on disk returns 409 `stale` with `currentRev`: read the file again, merge, and save. A file deleted on disk drops out of the catalog, so its save returns 404 `skill_not_found`; 409 `deleted` comes only when it goes during the save. A name that is not 1-64 lowercase letters, digits and single hyphens returns 422 `invalid_name`; a description that is empty, longer than 1024 characters or more than one line returns 422 `invalid_description`. An existing skill folder returns 409 `skill_exists`. A file over 1 MB returns 413.

Delete an editable entry with `DELETE /api/skills/file` and `{path,expectedRev}`. Use the revision from the file you opened. The server checks the current catalog and edit permission again. A SKILL.md entry removes its whole skill folder, including scripts and resources; a legacy command removes its one file. Links are unlinked only: their targets, including child-link targets, remain. Built-in and plugin skills cannot be deleted. A successful delete returns 204 and refreshes Sk menus. The revision guards the opened file, not a snapshot of its resources. A changed file returns 409 `stale`; a file removed after the catalog check returns 409 `deleted`; an I/O failure returns 500 `io_error`.
