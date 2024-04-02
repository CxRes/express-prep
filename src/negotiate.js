/*!
 *  Copyright (c) 2024, Rahul Gupta
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import { item, mediaType } from "structured-field-utils";

/**
 * Common negotiate function for different types of fields
 *
 */
function negotiateField(requestedFields, allowedFields, fieldType) {
  const rFields = Array.isArray(requestedFields)
    ? requestedFields
    : [[requestedFields, new Map()]];
  const aFields = Array.isArray(allowedFields)
    ? allowedFields
    : [[allowedFields, new Map()]];

  const sortedFields = fieldType.sort(rFields);

  for (const requestedField of sortedFields) {
    for (const allowedField of aFields) {
      const isMatch = fieldType.match(requestedField, allowedField);
      if (isMatch) {
        const match = allowedField.slice();
        if (typeof isMatch !== "boolean") {
          match.push(isMatch); // return mismatched parameters as a 3rd array entry
        }
        return match;
      }
    }
  }
}

/**
 * Takes in requested and allowed items to find the best match.
 * If there are mismatched parameters or parameters are a list, it includes them
 * from the request as a third array entry; allowing ther user to choose how to
 * deal with mismatched parameters.
 */
function negotiateItem(requestedFields, allowedFields) {
  return negotiateField(requestedFields, allowedFields, item);
}

/**
 * Takes in requested and allowed media-types to find the best match.
 * If there are mismatched parameters or parameters are a list, it includes them
 * from the request as a third array entry; allowing ther user to choose how to
 * deal with mismatched parameters.
 */
function negotiateType(requestedFields, allowedFields) {
  return negotiateField(requestedFields, allowedFields, mediaType);
}

/**
 * Takes an array of requested and allowed items to find the best match.
 * Does not process media-type fields, ensure they are filtered first.
 */
function negotiateList(requestedFields, allowedFields) {
  const rFields = Array.isArray(requestedFields)
    ? requestedFields
    : [[requestedFields, new Map()]];
  const aFields = Array.isArray(allowedFields)
    ? allowedFields
    : [[allowedFields, new Map()]];

  const match = [];

  for (const requestedField of rFields) {
    for (const allowedField of aFields) {
      const isMatch = item.match(requestedField, allowedField);
      if (isMatch) {
        if (typeof isMatch === "boolean") {
          match.push(allowedField.slice());
        } else {
          // return mismatched parameters as a 3rd array entry
          match.push(allowedField.slice().push(isMatch));
        }
      }
    }
  }

  return match;
}

/**
 * Negotiates the best matching `Content-*` based on the requested and
 * available media types. Currently limited to `Content-Type`
 */
function negotiateContentStar(request, available) {
  // For now we will match `accept` event-field only to get the content-type.
  // This can be extended to other `accept-*` event-fields in the future.
  const contentType = negotiateType(
    request.get("accept") || [["*/*", new Map()]],
    available.get("accept"),
  );

  return (
    contentType &&
    Object.freeze({
      "content-type": contentType,
    })
  );
}

/**
 * Filters out extra the Parameters Map added as a third array element to an
 * Item by the negotiate functions.
 */
function cleanUp(obj) {
  const filteredObj = {};
  for (const prop in obj) {
    if (Array.isArray(obj[prop])) {
      filteredObj[prop] = [];
      if (Array.isArray(obj[prop][0])) {
        filteredObj[prop] = obj[prop].map((item) => [item[0], item[1]]);
      } else {
        filteredObj[prop].push(obj[prop][0], obj[prop][1]);
      }
    }
  }
  return filteredObj;
}

export {
  negotiateContentStar as content,
  negotiateType as type,
  negotiateItem as item,
  negotiateList as list,
  cleanUp,
};
