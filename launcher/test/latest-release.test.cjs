"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  __test,
  fetchLatestReleaseState,
} = require("../latest-release.cjs");

test("latest release follows the repository configured by this fork", async () => {
  assert.equal(__test.DEFAULT_RELEASE_REPOSITORY, "AEmbers/OpenCodex");
  assert.equal(
    __test.DEFAULT_RELEASE_API_URL,
    "https://api.github.com/repos/AEmbers/OpenCodex/releases/latest"
  );

  const requestedUrls = [];
  const state = await fetchLatestReleaseState({
    currentVersionLabel: "2.1.1",
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          tag_name: "v2.1.2",
          html_url: "https://github.com/AEmbers/OpenCodex/releases/tag/v2.1.2",
        }),
      };
    },
  });

  assert.deepEqual(requestedUrls, [__test.DEFAULT_RELEASE_API_URL]);
  assert.equal(state.available, true);
  assert.equal(state.htmlUrl, "https://github.com/AEmbers/OpenCodex/releases/tag/v2.1.2");
});

test("latest release rejects links that escape the configured fork", async () => {
  assert.equal(
    __test.trustedReleaseUrl("https://github.com/RyensX/OpenCodex/releases/tag/v2.1.2"),
    ""
  );
  assert.equal(
    __test.trustedReleaseUrl("https://github.com.example/AEmbers/OpenCodex/releases/tag/v2.1.2"),
    ""
  );
  assert.equal(
    __test.trustedReleaseUrl("http://github.com/AEmbers/OpenCodex/releases/tag/v2.1.2"),
    ""
  );

  const state = await fetchLatestReleaseState({
    currentVersionLabel: "2.1.1",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tag_name: "v2.1.2",
        html_url: "https://github.com/RyensX/OpenCodex/releases/tag/v2.1.2",
      }),
    }),
  });
  // API 返回异常仓库时只隐藏更新入口，不能把用户导航到其他维护者的发布页。
  assert.equal(state.available, false);
  assert.equal(state.htmlUrl, "");
});
