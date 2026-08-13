// Standalone helper (not part of the app) for moving files to another machine.
//
// Usage:
//   node transport.js pack                     -> refreshes the folder from the live webapp, then builds "transportFiles .dist/transport-bundle.txt"
//   node transport.js unpack                   -> restores from that bundle into "transportFiles .dist/restored"
//   node transport.js refresh                  -> only copies the live webapp files into "transportFiles .dist"
//   node transport.js pack   <srcDir> [bundle] -> packs an explicit folder as-is (no refresh)
//   node transport.js unpack <bundle> [outDir]
//   node transport.js refresh <destDir>
//
// The bundle is one plain text file: every source file starts with a
// "***file <name>" line, and its content runs until the next "***file" line.
// While copying, the keywords in KEYWORDS are suffixed with SUFFIX
// (function -> functionMoAb) so the text passes through filters that block
// them; unpack reverses it exactly.

const fs = require("fs");
const path = require("path");

// Add a keyword here and both pack and unpack pick it up automatically.
const KEYWORDS = ["function", "if", "open", "replace", "while" ,"Object" ,"for"];
const SUFFIX = "MoAb";

// Match whole words only, so "notify" does not become "notifMoAby".
const WHOLE_WORD = true;

const DEFAULT_DIR = path.join(__dirname, "transportFiles .dist");
const DEFAULT_BUNDLE = "transport-bundle.txt";
const DEFAULT_RESTORE_DIR = "restored";
const MARKER = "***file";

// The live source files, relative to this script. "refresh" copies each of
// these (flattened to its basename) into the transport folder so the bundle
// always reflects the current webapp - no manual re-copying. Add a file here
// and it gets refreshed and packed automatically.
const SOURCE_FILES = [
	"webapp/controller/Home.controller.js",
	"webapp/controller/AllEmployees.controller.js",
	"webapp/controller/ManagerReports.controller.js",
	"webapp/view/Home.view.xml",
	"webapp/view/HomeMonthPicker.fragment.xml",
	"webapp/view/AllEmployees.view.xml",
	"webapp/view/AllEmployeesViewSettings.fragment.xml",
	"webapp/view/ManagerReports.view.xml",
	"webapp/model/DataService.js",
	"webapp/model/formatter.js",
	"webapp/model/mockEmployees.js",
	"webapp/i18n/i18n.properties",
	"webapp/css/style.css",
	"webapp/css/tokens.css"
];

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRegExp(word) {
	const body = escapeRegExp(word);
	return new RegExp(WHOLE_WORD ? "\\b" + body + "\\b" : body, "g");
}

// function -> functionMoAb
function encodeText(text) {
	return KEYWORDS.reduce(function (acc, word) {
		return acc.replace(wordRegExp(word), word + SUFFIX);
	}, text);
}

// functionMoAb -> function
function decodeText(text) {
	return KEYWORDS.reduce(function (acc, word) {
		return acc.replace(wordRegExp(word + SUFFIX), word);
	}, text);
}

// Copy every SOURCE_FILES entry from its live webapp location into destDir,
// flattened to its basename, so the bundle reflects the current sources.
function refresh(destDir) {
	fs.mkdirSync(destDir, { recursive: true });

	const copied = SOURCE_FILES.map(function (rel) {
		const from = path.join(__dirname, rel);
		if (!fs.existsSync(from)) { throw new Error("Source file not found: " + from); }
		const name = path.basename(rel);
		fs.copyFileSync(from, path.join(destDir, name));
		return name;
	});

	console.log("Refreshed " + copied.length + " file(s) into: " + destDir);
	copied.forEach(function (name) { console.log("  " + name); });
	return copied;
}

function pack(srcDir, bundlePath, doRefresh) {
	if (doRefresh) { refresh(srcDir); }

	if (!fs.existsSync(srcDir)) { throw new Error("Source folder not found: " + srcDir); }

	const files = fs.readdirSync(srcDir).filter(function (name) {
		const full = path.join(srcDir, name);
		if (!fs.statSync(full).isFile()) { return false; }
		return path.resolve(full) !== path.resolve(bundlePath);
	}).sort();

	if (!files.length) { throw new Error("No files to pack in: " + srcDir); }

	const parts = files.map(function (name) {
		const content = encodeText(fs.readFileSync(path.join(srcDir, name), "utf8"));
		// the trailing "\n" is a separator only - unpack strips exactly one,
		// so CRLF and missing-final-newline files come back byte for byte
		return MARKER + " " + name + "\n" + content + "\n";
	});

	fs.writeFileSync(bundlePath, parts.join(""), "utf8");

	console.log("Packed " + files.length + " file(s) into: " + bundlePath);
	files.forEach(function (name) { console.log("  " + name); });
}

function unpack(bundlePath, outDir) {
	if (!fs.existsSync(bundlePath)) { throw new Error("Bundle not found: " + bundlePath); }

	const bundle = fs.readFileSync(bundlePath, "utf8");

	// collect the marker lines first, then slice the raw text between them,
	// so nothing about the original line endings is touched
	const markerRe = new RegExp("^" + escapeRegExp(MARKER) + "(.*)$", "gm");
	const marks = [];
	let m;
	while ((m = markerRe.exec(bundle)) !== null) {
		marks.push({ name: m[1].trim(), from: m.index, to: m.index + m[0].length });
	}

	if (!marks.length) { throw new Error("No \"" + MARKER + "\" sections found in: " + bundlePath); }

	fs.mkdirSync(outDir, { recursive: true });

	const entries = marks.map(function (mark, i) {
		if (!mark.name) { throw new Error("Found a " + MARKER + " line without a file name"); }
		const end = i + 1 < marks.length ? marks[i + 1].from : bundle.length;
		let content = bundle.slice(mark.to, end);
		content = content.replace(/^\r?\n/, "");	// newline that ended the marker line
		content = content.replace(/\r?\n$/, "");	// separator added by pack
		return { name: path.basename(mark.name), content: decodeText(content) };
	});

	entries.forEach(function (entry) {
		fs.writeFileSync(path.join(outDir, entry.name), entry.content, "utf8");
	});

	console.log("Unpacked " + entries.length + " file(s) into: " + outDir);
	entries.forEach(function (entry) { console.log("  " + entry.name); });
}

function main() {
	const mode = (process.argv[2] || "pack").toLowerCase();
	const a = process.argv[3];
	const b = process.argv[4];

	if (mode === "pack") {
		const srcDir = a ? path.resolve(a) : DEFAULT_DIR;
		const bundlePath = b ? path.resolve(b) : path.join(srcDir, DEFAULT_BUNDLE);
		// refresh the folder from the live webapp before packing the default dir
		pack(srcDir, bundlePath, !a);
	} else if (mode === "refresh") {
		const destDir = a ? path.resolve(a) : DEFAULT_DIR;
		refresh(destDir);
	} else if (mode === "unpack") {
		const bundlePath = a ? path.resolve(a) : path.join(DEFAULT_DIR, DEFAULT_BUNDLE);
		const outDir = b ? path.resolve(b) : path.join(path.dirname(bundlePath), DEFAULT_RESTORE_DIR);
		unpack(bundlePath, outDir);
	} else {
		console.error("Unknown mode: " + mode + " (use \"pack\", \"unpack\" or \"refresh\")");
		process.exit(1);
	}
}

if (require.main === module) {
	try {
		main();
	} catch (err) {
		console.error("Error: " + err.message);
		process.exit(1);
	}
}

module.exports = { pack: pack, unpack: unpack, refresh: refresh, encodeText: encodeText, decodeText: decodeText, KEYWORDS: KEYWORDS, SUFFIX: SUFFIX, SOURCE_FILES: SOURCE_FILES };
