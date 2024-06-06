/*!
 *  Copyright (c) 2024, Rahul Gupta
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */

/**
 * A template that generates headers for part message in a multipart body
 */
function headerTemplate(negotiatedFields) {
  return Object.entries(negotiatedFields).reduce((header, [key, value]) => {
    const k = key.toLowerCase();
    const v = (Array.isArray(value) ? value[0] : value).toLowerCase();
    if (k.startsWith("content-")) {
      if (k !== "content-type" || v !== "message/rfc822") {
        return `${header}${key}: ${v}\r\n`;
      }
    }
    return header;
  }, "");
}

/**
 * A template that generates an RFC822 formatted notification using semantics
 * defined in the PREP specification.
 */
function rfc822Template({ method, date, eTag, eventID, location, delta }) {
  let msg = `Method: ${method}\r
Date: ${date}\r
`;

  // Include `event-ID`, if available
  if (eventID) {
    msg = `${msg}Event-ID: ${eventID}\r\n`;
  }

  // Include `E-Tag`, if available
  if (eTag) {
    msg = `${msg}ETag: ${eTag}\r\n`;
  }

  // Add `Content-Location`, if Available
  if (location) {
    msg = `${msg}Content-Location: ${location}\r\n`;
  }

  // Add delta, if requested
  if (delta && method.startsWith("P")) {
    msg = `${msg}\r\n${delta}`;
  }

  return msg;
}

export { rfc822Template as rfc822, headerTemplate as header };
