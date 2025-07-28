import * as terminal from "./terminal/terminal.js";
import {__main} from "./system/system.js";

function run() {
    __main(terminal.main, 0, 0, "/");
}

document.addEventListener("DOMContentLoaded", run);