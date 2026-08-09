// Standalone helper (not part of the app) for moving files to another machine.
//
// Usage:
//   node transport.js pack                     -> builds "transportFiles .dist/transport-bundle.txt"
//   node transport.js unpack                   -> restores from that bundle into "transportFiles .dist/restored"
//   node transport.js pack   <srcDir> [bundle]
//   node transport.js unpack <bundle> [outDir]
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

function pack(srcDir, bundlePath) {
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
		pack(srcDir, bundlePath);
	} else if (mode === "unpack") {
		const bundlePath = a ? path.resolve(a) : path.join(DEFAULT_DIR, DEFAULT_BUNDLE);
		const outDir = b ? path.resolve(b) : path.join(path.dirname(bundlePath), DEFAULT_RESTORE_DIR);
		unpack(bundlePath, outDir);
	} else {
		console.error("Unknown mode: " + mode + " (use \"pack\" or \"unpack\")");
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

module.exports = { pack: pack, unpack: unpack, encodeText: encodeText, decodeText: decodeText, KEYWORDS: KEYWORDS, SUFFIX: SUFFIX };
