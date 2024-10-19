/*!
 *  Copyright (c) 2024, Rahul Gupta and Express PREP contributors.
 *
 *  This Source Code Form is subject to the terms of the Mozilla Public
 *  License, v. 2.0. If a copy of the MPL was not distributed with this
 *  file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 *  SPDX-License-Identifier: MPL-2.0
 */
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { parseDictionary } from "structured-headers";
import { multipartFetch, parseBody } from "multipart-fetch";
import server from "../shared/streaming-server.js";

const PORT = process.env.PORT || 9001;
const TEST_URL = `http://localhost:${PORT}/`;

describe("PREP Middleware Notifications Response", () => {
  let response, notifications, notification, note, parts;

  beforeAll(() => {
    server.listen(PORT);
  });

  afterAll(() => {
    server.close();
  });

  it('should contain Events header with protocol set to "prep"', async () => {
    response = await fetch(TEST_URL, {
      headers: {
        "Accept-Events": `"prep"`,
      },
    });

    const eventsHeader = response.headers.get("events");
    const events = parseDictionary(eventsHeader);
    expect(events.get("protocol")?.[0]?.toString()).toBe("prep");
    expect(events.get("status")?.[0]).toBe(200);
  });

  it("should contain Vary header with Accept-Events", async () => {
    const vary = response.headers.get("vary");
    expect(vary.toLowerCase()).toMatch(/accept-events/);
  });

  it("should have the content-type header set to multipart/mixed", () => {
    expect(
      response.headers.get("content-type").startsWith("multipart/mixed"),
    ).toBe(true);
  });

  it("should output the representation as the first part", async () => {
    const multipartResponse = multipartFetch(response);
    parts = multipartResponse.parts();
    const { value: representation } = await parts.next();
    expect(representation.headers.get("content-type")).toBe("text/plain");
    await expect(representation.text()).resolves.toMatch(/The.*dog\./);
  });

  it("should output the notifications as the second part", async () => {
    const { value } = await parts.next();
    const notificationsResponse = multipartFetch(value);

    expect(notificationsResponse.subtype).toBe("digest");
    notifications = notificationsResponse.parts();
  });

  it("should send a notification when it receives a PATCH request", async () => {
    const response = await fetch(`http://localhost:${PORT}/`, {
      method: "PATCH",
      body: "something",
    });
    await response.text();
    ({ value: notification } = await notifications.next());
    expect(notification.headers.get("content-type")).toBe("message/rfc822");
  });

  it("should set the method to PATCH in the notification", async () => {
    note = await parseBody(notification.body);
    expect(note.headers.get("method")).toBe("PATCH");
  }, 500);

  it("should not have delta in the PATCH notification", async () => {
    await expect(note.text()).resolves.toBeFalsy();
  }, 500);

  it("should send a notification when it receives a PUT request", async () => {
    await fetch(`http://localhost:${PORT}/`, {
      method: "PUT",
    });

    ({ value: notification } = await notifications.next());
    expect(notification.headers.get("content-type")).toBe("message/rfc822");
  });

  it("should set the method to PUT in the notification", async () => {
    note = await parseBody(notification.body);
    expect(note.headers.get("method")).toBe("PUT");
  });

  it("should not have delta in the PUT notification", async () => {
    await expect(note.text()).resolves.toBeFalsy();
  });

  it("should send a notification when it receives a DELETE request", async () => {
    await fetch(TEST_URL, {
      method: "DELETE",
    });
    ({ value: notification } = await notifications.next());

    expect(notification.headers.get("content-type")).toBe("message/rfc822");
  });

  it("should set the method to DELETE in the notification", async () => {
    const note = await parseBody(notification.body);
    expect(note.headers.get("method")).toBe("DELETE");
    await expect(note.text()).resolves.toBeFalsy();
  });

  it("should close the stream following delete", async () => {
    let done;

    ({ done } = await notifications.next());
    expect(done).toBe(true);

    ({ done } = await parts.next());
    expect(done).toBe(true);
  });
});
