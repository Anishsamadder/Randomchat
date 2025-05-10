import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const applicationTables = {
  chatSessions: defineTable({
    userA: v.id("users"),
    userB: v.id("users"),
    active: v.boolean(),
    hasVideo: v.optional(v.boolean()),
  }),
  messages: defineTable({
    sessionId: v.id("chatSessions"),
    content: v.string(),
    authorId: v.id("users"),
  }).index("by_session", ["sessionId"]),
  waitingUsers: defineTable({
    userId: v.id("users"),
    joinedAt: v.number(),
    wantsVideo: v.boolean(),
  }).index("by_joined", ["joinedAt"]),
  rtcSignaling: defineTable({
    sessionId: v.id("chatSessions"),
    fromUserId: v.id("users"),
    toUserId: v.id("users"),
    type: v.string(),
    payload: v.string(),
  }).index("by_session_and_to", ["sessionId", "toUserId"]),
};

export default defineSchema({
  ...authTables,
  ...applicationTables,
});
