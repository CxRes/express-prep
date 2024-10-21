/*!
 *  Copyright (c) 2024, Rahul Gupta and Express PREP contributors.
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import { EventEmitter } from "node:events";
import _ from "lodash";

import Debug from "debug";

const debug = Debug("prep:engine");

/**
 * The `defaultComparator` function compares if the negotiated event-fields
 * are same.
 */
function defaultComparator(storedFields, receivedFields) {
  return _.isEqual(storedFields, receivedFields);
}

/**
 * A factory function that creates an instance of a
 * Events Engine for notifications. It can optionally be configured with
 * a `comparator` function that modifies how the stored negotiated fields are
 * matched to received fields.
 */
function EventsFactory({ comparator = defaultComparator } = {}) {
  /**
   * The `list` Map stores separate event handlers for each negotiated fields
   * combination for notifications sent from a given URL path.
   */
  const list = new Map();

  /**
   * Registers notification handlers for each URL path and runs them upon
   * notification events.
   */
  function subscribe({ path, negotiatedFields, handler, endHandler }) {
    if (!list.has(path)) {
      debug(`creating new URL path ${path}`);
      list.set(path, new Map());
    }

    const searchResults = [...list.get(path).keys()].find(
      (/** @type negotiatedFields */ value) =>
        comparator(value, negotiatedFields),
    );

    const fields = searchResults || negotiatedFields;

    if (!searchResults) {
      debug(
        `creating new emitter for content-type ${fields["content-type"]} on URL path ${path}`,
      );
      list.get(path).set(fields, new EventEmitter());
    }

    debug(
      `adding handlers for content-type ${fields["content-type"].toString()} on URL path ${path}`,
    );
    list
      .get(path)
      .get(fields)
      .on("notification", handler)
      .on("end", endHandler);

    return () => {
      return removeHandlers({
        path,
        negotiatedFields: fields,
        handler,
        endHandler,
      });
    };
  }

  /**
   * Sends the notifications to all subscribers of a specific URL path.
   */
  function notify({ path, generateNotification, lastEvent }) {
    if (!list.has(path)) {
      debug(`The URL path ${path} has not been subscribed for Notifications`);
      return;
    }
    debug(`Triggering notifications on URL path ${path}`);
    list.get(path).forEach((event, negotiatedFields) => {
      const notification = generateNotification(negotiatedFields);
      if (notification) {
        event.emit("notification", notification, lastEvent);
      }
      if (lastEvent) {
        event.emit("end");
      }
    });
  }

  /**
   * Removes the event handlers associated with a specific subscription.
   */
  function removeHandlers({ path, negotiatedFields, handler, endHandler }) {
    const fieldMap = list.get(path);
    const emitter = fieldMap?.get(negotiatedFields);
    emitter?.off("notification", handler).off("end", endHandler);

    if (emitter?.listenerCount("notification") === 0) {
      fieldMap?.delete(negotiatedFields);
    }
    if (fieldMap?.size === 0) {
      list.delete(path);
    }
  }

  /**
   * Each Instance of the Engine provides a way to notify events and
   * a way to subscribe to receive these events.
   */
  return Object.freeze({
    subscribe,
    notify,
  });
}

export default EventsFactory;
