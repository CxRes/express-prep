/*!
 *  Copyright (c) 2024, Rahul Gupta and Express PREP contributors.
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import cryptoRandomString from "crypto-random-string";

/**
 * Stores the last event ID for each URL for which a mutation request is made.
 * A simple memory storage will suffice here, though one may want to persist
 * and deduplicate IDs in a production environment.
 */
const lastEventIDs = {};

/**
 * A middleware function that provides a way to set and retrieve a unique
 * event ID for each request.
 */
function eventID(req, res, next) {
  /**
   * Sets a unique event ID for the last event on a given URL.
   */
  res.setEventID = function setEventID(path) {
    const lastEventID = cryptoRandomString({ length: 6, type: "alphanumeric" });
    lastEventIDs[path || req.path];
    return lastEventID;
  };

  /**
   * Retrieves the last event ID generated for the last request that modified
   * the resource on the URL.
   */
  Object.defineProperty(res, "lastEventID", {
    get() {
      return lastEventIDs[req.path];
    },
  });

  return next && next();
}

export default eventID;
