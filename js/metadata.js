/**
 * metadata.js
 *
 * A small, self-contained JPEG EXIF reader. It looks only at the APP1
 * segment and pulls out the handful of fields UNSEND cares about for a
 * warning banner -- it is not a general-purpose EXIF library.
 *
 * Metadata REMOVAL does not happen here: re-rendering the image onto a
 * <canvas> and exporting via toBlob()/toDataURL() naturally drops EXIF,
 * so "removing metadata" is really just "not copying the original bytes".
 * This module exists purely to tell the user what was present beforehand.
 */

const Metadata = (() => {

  const TAGS = {
    0x010F: 'make',
    0x0110: 'model',
    0x0131: 'software',
    0x0132: 'dateTime',
    0x9003: 'dateTimeOriginal',
    0x8298: 'copyright',
    0x010E: 'imageDescription',
    0x013B: 'artist',
  };

  function readEXIF(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) {
      return null; // not a JPEG
    }

    let offset = 2;
    let app1 = null;
    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      if (marker === 0xffe1) {
        app1 = offset;
        break;
      }
      if ((marker & 0xff00) !== 0xff00) break; // corrupt / not a marker
      const segLength = view.getUint16(offset + 2);
      offset += 2 + segLength;
    }
    if (app1 === null) return { present: false };

    const exifStart = app1 + 4; // skip marker + length
    // "Exif\0\0"
    if (view.getUint32(exifStart) !== 0x45786966) return { present: false };
    const tiffStart = exifStart + 6;
    const little = view.getUint16(tiffStart) === 0x4949;

    function g16(o) { return view.getUint16(o, little); }
    function g32(o) { return view.getUint32(o, little); }

    const ifdOffset = tiffStart + g32(tiffStart + 4);
    const result = { present: true, fields: {}, hasGPS: false };

    function readIFD(ifdStart, isGPS) {
      if (ifdStart <= 0 || ifdStart + 2 > view.byteLength) return null;
      const count = g16(ifdStart);
      let gpsIFDPointer = null;
      for (let i = 0; i < count; i++) {
        const entryOffset = ifdStart + 2 + i * 12;
        if (entryOffset + 12 > view.byteLength) break;
        const tag = g16(entryOffset);
        const type = g16(entryOffset + 2);
        const numValues = g32(entryOffset + 4);
        const valueOffset = entryOffset + 8;

        if (!isGPS && tag === 0x8825) {
          gpsIFDPointer = tiffStart + g32(valueOffset);
          result.hasGPS = true;
          continue;
        }

        if (isGPS) continue; // presence is enough; we don't decode coordinates

        const name = TAGS[tag];
        if (!name) continue;

        if (type === 2) { // ASCII string
          let strOffset = numValues > 4 ? tiffStart + g32(valueOffset) : valueOffset;
          let str = '';
          for (let b = 0; b < numValues - 1 && strOffset + b < view.byteLength; b++) {
            str += String.fromCharCode(view.getUint8(strOffset + b));
          }
          if (str.trim()) result.fields[name] = str.trim();
        }
      }
      return gpsIFDPointer;
    }

    const gpsPointer = readIFD(ifdOffset, false);
    if (gpsPointer) readIFD(gpsPointer, true);

    return result;
  }

  function summarize(exif) {
    if (!exif || !exif.present) return { warnings: [], hasAny: false };
    const warnings = [];
    if (exif.hasGPS) warnings.push('GPS LOCATION FOUND');
    if (exif.fields.make || exif.fields.model) warnings.push('CAMERA INFORMATION FOUND');
    if (exif.fields.dateTimeOriginal || exif.fields.dateTime) warnings.push('ORIGINAL TIMESTAMP FOUND');
    if (exif.fields.software) warnings.push('SOFTWARE INFO FOUND');
    if (exif.fields.artist || exif.fields.copyright) warnings.push('AUTHOR / COPYRIGHT INFO FOUND');
    return {
      warnings,
      hasAny: warnings.length > 0 || Object.keys(exif.fields).length > 0,
      fields: exif.fields,
      hasGPS: exif.hasGPS,
    };
  }

  /**
   * Reads metadata for any supported file. Returns a summary object.
   * PNG/WebP: canvas re-encoding already strips ancillary chunks, and we
   * don't attempt full chunk parsing here -- we report "not inspected"
   * rather than falsely claiming there is none.
   */
  async function inspect(file) {
    if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
      const buf = await file.arrayBuffer();
      try {
        const exif = readEXIF(buf);
        return summarize(exif);
      } catch (e) {
        return { warnings: [], hasAny: false, error: true };
      }
    }
    return { warnings: [], hasAny: false, notInspected: true };
  }

  return { readEXIF, summarize, inspect };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Metadata;