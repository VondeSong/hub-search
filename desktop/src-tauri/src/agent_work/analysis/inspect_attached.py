"""Read a bounded preview of explicitly selected data. Produce no artifacts."""
import csv
import json
import sys
from pathlib import Path


def preview_text(value):
    text = "" if value is None else str(value)
    return text[:60] + ("…" if len(text) > 60 else "")


def preview_row(row):
    return [preview_text(cell) for cell in row[:12]]


def inspect_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        prefix = stream.read(4096)
        try:
            dialect = csv.Sniffer().sniff(prefix, delimiters=",;\t")
        except csv.Error:
            dialect = "excel"
        stream.seek(0)
        csv.field_size_limit(10 * 1024 * 1024)
        reader = csv.reader(stream, dialect, strict=True)
        header = next((row for row in reader if row), [])
        rows = []
        row_count = 0
        inconsistent = 0
        for row in reader:
            if not row:
                continue
            row_count += 1
            inconsistent += len(row) != len(header)
            if len(rows) < 3:
                rows.append(preview_row(row))
        return {
            "columnCount": len(header),
            "headersPreview": preview_row(header),
            "dataRowCount": row_count,
            "rowsWithDifferentColumnCount": inconsistent,
            "firstDataRowsPreview": rows,
        }


def inspect_xlsx(path):
    from openpyxl.reader.excel import ExcelReader

    class PreviewReader(ExcelReader):
        def read_custom(self):
            # A worksheet preview does not use optional document properties.
            pass

    reader = PreviewReader(path, read_only=True, data_only=True, keep_links=False)
    try:
        reader.read()
        workbook = reader.wb
        sheets = [
            {"name": preview_text(sheet.title), "declaredRows": sheet.max_row,
             "declaredColumns": sheet.max_column}
            for sheet in workbook.worksheets[:12]
        ]
        for metadata, sheet in zip(sheets, workbook.worksheets[:2]):
            row_preview = []
            first_value_row = None
            scanned_through_row = 0
            for number, row in enumerate(
                sheet.iter_rows(min_row=1, min_col=1, max_row=8, max_col=12, values_only=True), 1
            ):
                scanned_through_row = number
                # Empty rows and repeated cells in title banners consume the
                # preview without helping locate the actual table.
                distinct = {str(cell) for cell in row if cell is not None and cell != ""}
                if distinct and first_value_row is None:
                    first_value_row = {"row": number, "cells": preview_row(row)}
                if len(distinct) >= 2 or (distinct and sheet.max_column == 1):
                    row_preview.append({"row": number, "cells": preview_row(row)})
                if len(row_preview) == 2:
                    break
            metadata["scannedThroughRow"] = scanned_through_row
            metadata["previewColumnLimit"] = 12
            metadata["tableRowsPreview"] = row_preview or (
                [first_value_row] if first_value_row else []
            )
        return {"worksheetCount": len(workbook.worksheets), "worksheetsPreview": sheets}
    finally:
        reader.archive.close()


def inspect_json(path):
    with path.open(encoding="utf-8-sig") as stream:
        value = json.load(stream)
    if isinstance(value, list):
        return {"rootType": "array", "itemCount": len(value),
                "firstItemsPreview": [preview_text(item) for item in value[:3]]}
    if isinstance(value, dict):
        return {"rootType": "object", "keyCount": len(value),
                "keysPreview": [preview_text(key) for key in list(value)[:12]]}
    return {"rootType": type(value).__name__, "valuePreview": preview_text(value)}


sys.stdout.reconfigure(encoding="utf-8")
manifest = json.loads(Path("input.json").read_text(encoding="utf-8"))
inspectors = {".csv": inspect_csv, ".xlsx": inspect_xlsx, ".json": inspect_json}
results = []
for item in manifest["files"]:
    path = Path(item["path"])
    result = {"inputId": item["inputId"]}
    try:
        result["preview"] = inspectors[path.suffix](path)
    except Exception:
        result["readError"] = "无法读取数据预览，请核对文件格式，或用文件分析工具进一步检查。"
    results.append(result)
print(json.dumps({"selectedFilePreviews": results}, ensure_ascii=False))
