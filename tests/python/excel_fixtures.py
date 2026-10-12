"""Synthetic Excel workbooks for runtime dependency checks.

openpyxl writes .xlsx; nothing in the dependency set writes .xlsb, so `make_xlsb`
emits the minimal BIFF12 parts pyxlsb reads: workbook.bin with one sheet entry,
its relationship, and one worksheet.
"""

import struct
import zipfile
from pathlib import Path

from openpyxl import Workbook

ROWS = [["group", "value"], ["A", 2.0], ["B", 4.0]]


def make_xlsx(path: Path) -> None:
    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    for row in ROWS:
        sheet.append(row)
    book.save(path)


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _record(record_id: int, payload: bytes = b"") -> bytes:
    # Record ids are little-endian with the high bit marking a continuation byte.
    if record_id < 0x80:
        rid = bytes([record_id])
    else:
        rid = struct.pack("<H", record_id)
    return rid + _varint(len(payload)) + payload


def _string(text: str) -> bytes:
    return struct.pack("<I", len(text)) + text.encode("utf-16-le")


def make_xlsb(path: Path) -> None:
    workbook = (
        _record(0x018F)  # SHEETS
        + _record(0x019C, struct.pack("<II", 0, 1) + _string("rId1") + _string("Data"))
        + _record(0x0190)  # SHEETS_END
    )
    cells = bytearray()
    for r, row in enumerate(ROWS):
        cells += _record(0x0000, struct.pack("<I", r) + bytes(21))  # ROW
        for c, value in enumerate(row):
            if isinstance(value, str):  # FORMULA_STRING carries an inline string
                cells += _record(0x0008, struct.pack("<II", c, 0) + _string(value))
            else:  # FLOAT
                cells += _record(0x0005, struct.pack("<IId", c, 0, value))
    sheet = (
        _record(0x0181)  # WORKSHEET
        + _record(0x0194, struct.pack("<IIII", 0, len(ROWS) - 1, 0, 1))  # DIMENSION
        + _record(0x0191)  # SHEETDATA
        + bytes(cells)
        + _record(0x0192)  # SHEETDATA_END
        + _record(0x0182)  # WORKSHEET_END
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Target="worksheets/sheet1.bin" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/workbook.bin", workbook)
        z.writestr("xl/_rels/workbook.bin.rels", rels)
        z.writestr("xl/worksheets/sheet1.bin", sheet)
