# UNSEND

**Make screenshots safe to share.**

UNSEND is a browser-based privacy tool for finding and permanently redacting sensitive information from screenshots and images.

Drop an image, let UNSEND look for things you may have missed, review the detections, redact what you want, and download a clean copy.

Everything happens locally in your browser.

## What it can find

UNSEND can detect common privacy-sensitive information such as:

* Email addresses
* Phone numbers
* URLs
* IPv4 addresses
* Credit-card-like numbers
* Possible API keys and tokens
* Usernames and handles
* QR codes
* Image metadata

Detection combines client-side OCR with pattern matching and image analysis.

Detections are suggestions, not guarantees. You can review, ignore, or manually redact anything yourself.

## Redaction

UNSEND supports several ways to hide information:

* Solid redaction
* Pixelation
* Blur
* Manual rectangular redaction

Solid redaction is the recommended option for sensitive information because the original pixels are replaced in the exported image.

The original image is never modified.

## Metadata

Images can contain information that is not visible in the image itself.

Where supported, UNSEND can inspect metadata such as:

* GPS location
* Camera make and model
* Software
* Timestamps
* Author information
* Comments
* EXIF data

You can remove supported metadata when creating a safe copy.

## Safe copies

UNSEND does not overwrite your original file.

Instead, it creates a new image such as:

```text
screenshot.png
        ↓
screenshot-safe.png
```

The safe copy contains the selected redactions and any requested metadata removal.

Where practical, UNSEND re-analyzes the output to verify that the requested changes were actually applied.

## Privacy

UNSEND is designed to work entirely in the browser.

Your images are not uploaded to a server.

There are:

* No accounts
* No backend
* No cloud processing
* No image uploads
* No analytics
* No tracking

This also means that image processing depends on the capabilities and performance of your browser and device.

## Supported formats

Current image support includes:

* JPEG
* PNG
* WebP

Additional formats may be supported in the future.

## Limitations

UNSEND is a privacy utility, not a guarantee that an image contains no sensitive information.

OCR and automatic detection can produce false positives or miss information.

Blur and pixelation should not be treated as equivalent to permanent redaction. For information that must be hidden, use solid redaction.

Metadata support depends on the image format and the metadata structures present in the file.

QR and sensitive-information detection are also not guaranteed to find everything.

Always review the final image before sharing it.

## Running locally

Clone the repository and serve it as a static website.

For example:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

If the project includes a Node-based development or test setup, see `package.json` for the available scripts.

## Development

The project is intentionally built around browser technologies and local processing.

The main pieces are separated into areas such as:

```text
OCR
  ↓
Detection
  ↓
Review
  ↓
Redaction
  ↓
Metadata cleaning
  ↓
Export
  ↓
Verification
```

The goal is to keep the implementation understandable and avoid unnecessary infrastructure.

## GitHub Pages

UNSEND can be deployed as a static website using GitHub Pages.

No server-side application is required.

## Why UNSEND?

Screenshots are easy to share and easy to overshare.

A screenshot can contain an email address, phone number, private URL, QR code, account information, or metadata without making any of it obvious.

UNSEND exists to make checking and cleaning that information quick and local.

