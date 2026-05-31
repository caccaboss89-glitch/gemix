/*
 * Fill a Word template (.docx/.dotx) with data using docxtemplater.
 *
 * Use this for templates that contain docxtemplater placeholders — {name},
 * loops ({#items}...{/items}), conditionals ({#hasFoo}...{/hasFoo}), and
 * dynamic table rows. For a plain literal find-and-replace on a normal Word
 * file (no placeholders), use replace_text.py instead.
 *
 * Usage:
 *   node /skills/docx/scripts/fill_template.js <template.docx> <data.json> <output.docx>
 *
 * The data JSON is the object passed to the template, e.g.:
 *   {
 *     "company": "Acme",
 *     "date": "2025-05-31",
 *     "items": [
 *       { "name": "Widget", "qty": 3, "price": "9.90" },
 *       { "name": "Gadget", "qty": 1, "price": "19.90" }
 *     ],
 *     "hasDiscount": true
 *   }
 *
 * Template authoring quick reference (inside the Word document):
 *   {company}                      simple placeholder
 *   {#items}{name} x{qty}{/items}  loop (put the pair in one paragraph, or use
 *                                  {#items} in a table row to repeat the row)
 *   {#hasDiscount}...{/hasDiscount} conditional section
 *   {^hasDiscount}...{/hasDiscount} inverted conditional (shown when falsy)
 *   {price | upper}                angular-expressions filter
 *
 * Notes:
 *   - paragraphLoop + linebreaks are enabled; "\n" in a value becomes a real
 *     line break in the document.
 *   - Image placeholders are NOT supported (the image module is not installed);
 *     add images after rendering with python-docx, or build from scratch with
 *     docx-js.
 */

const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const expressions = require("angular-expressions");

// Recommended angular-expressions parser: supports plain tags ({name}),
// dotted paths, filters ({x | upper}) and the special "." current-scope tag.
expressions.filters.upper = (input) =>
  input == null ? input : String(input).toUpperCase();
expressions.filters.lower = (input) =>
  input == null ? input : String(input).toLowerCase();

function angularParser(tag) {
  tag = tag
    .replace(/^\.$/, "this")
    .replace(/(\u2019|\u2018)/g, "'")
    .replace(/(\u201C|\u201D)/g, '"');
  const expr = expressions.compile(tag);
  return {
    get(scope, context) {
      if (tag === "this") return scope;
      const scopeList = context.scopeList;
      const num = context.num;
      for (let i = num; i >= 0; i--) {
        try {
          const result = expr(scopeList[i], scope);
          if (result !== undefined) return result;
        } catch (e) {
          /* try the next outer scope */
        }
      }
      return expr(scope);
    },
  };
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function reportTemplateErrors(error) {
  // docxtemplater aggregates template errors under error.properties.errors.
  const props = error && error.properties;
  if (props && Array.isArray(props.errors)) {
    console.error("Template errors:");
    for (const e of props.errors) {
      const ctx = e.properties || {};
      console.error(`  - ${e.message}` + (ctx.id ? ` (tag: ${ctx.id})` : "") +
        (ctx.explanation ? ` — ${ctx.explanation}` : ""));
    }
  } else {
    console.error(`  ${error && error.message ? error.message : error}`);
  }
}

function main() {
  const [, , templatePath, dataPath, outputPath] = process.argv;
  if (!templatePath || !dataPath || !outputPath) {
    fail("usage: node fill_template.js <template.docx> <data.json> <output.docx>");
  }
  if (!fs.existsSync(templatePath)) fail(`template not found: ${templatePath}`);
  if (!fs.existsSync(dataPath)) fail(`data file not found: ${dataPath}`);

  const ext = path.extname(templatePath).toLowerCase();
  if (ext !== ".docx" && ext !== ".dotx") {
    fail(`template must be .docx or .dotx (got ${ext})`);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  } catch (e) {
    fail(`could not parse JSON data: ${e.message}`);
  }

  let zip;
  try {
    zip = new PizZip(fs.readFileSync(templatePath, "binary"));
  } catch (e) {
    fail(`could not open template as a zip/docx: ${e.message}`);
  }

  let doc;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      parser: angularParser,
    });
    doc.render(data);
  } catch (error) {
    reportTemplateErrors(error);
    process.exit(1);
  }

  const buf = doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, buf);
  console.log(`Created: ${outputPath}`);
}

main();
