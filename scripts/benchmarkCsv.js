const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "experiments", "raw-data");

function csvEscape(value) {
    if (value === null || value === undefined) return "";

    const text = typeof value === "bigint"
        ? value.toString()
        : String(value);

    if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function writeCsvReport(scriptFile, suffix, headers, rows, options = {}) {
    const outputDir = options.subdir
        ? path.join(OUTPUT_DIR, options.subdir)
        : OUTPUT_DIR;

    fs.mkdirSync(outputDir, { recursive: true });

    const baseName = path.basename(scriptFile, path.extname(scriptFile));
    const fileName = suffix ? `${baseName}-${suffix}.csv` : `${baseName}.csv`;
    const filePath = path.join(outputDir, fileName);

    const lines = [headers.join(",")];
    for (const row of rows) {
        lines.push(headers.map((header) => csvEscape(row[header])).join(","));
    }

    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    console.log(`[csv] Wrote ${path.relative(process.cwd(), filePath)}`);
    return filePath;
}

function createCsvReportWriter(scriptFile, suffix, headers, options = {}) {
    const outputDir = options.subdir
        ? path.join(OUTPUT_DIR, options.subdir)
        : OUTPUT_DIR;

    fs.mkdirSync(outputDir, { recursive: true });

    const baseName = path.basename(scriptFile, path.extname(scriptFile));
    const fileName = suffix ? `${baseName}-${suffix}.csv` : `${baseName}.csv`;
    const filePath = path.join(outputDir, fileName);

    fs.writeFileSync(filePath, `${headers.join(",")}\n`, "utf8");
    console.log(`[csv] Started ${path.relative(process.cwd(), filePath)}`);

    let rowCount = 0;

    return {
        filePath,
        appendRow(row) {
            const line = headers.map((header) => csvEscape(row[header])).join(",");
            fs.appendFileSync(filePath, `${line}\n`, "utf8");
            rowCount += 1;
        },
        close() {
            console.log(`[csv] Finalized ${path.relative(process.cwd(), filePath)} (${rowCount} rows)`);
        },
    };
}

module.exports = {
    OUTPUT_DIR,
    createCsvReportWriter,
    writeCsvReport,
};