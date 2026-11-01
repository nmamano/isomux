// One folder file tool call of a Codex agent at the folder or web stop
// (server/folder-files.ts), as the agent user.
import {
  folderFilesCall,
  type FolderFilesRequest,
} from "../../folder-files.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => folderFilesCall(input as FolderFilesRequest));
