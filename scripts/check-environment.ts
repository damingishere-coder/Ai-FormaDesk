import { checkEnvironment } from "../server/environment";
import { codex } from "../server/codex";
console.log(JSON.stringify(await checkEnvironment(), null, 2));
codex.close();
