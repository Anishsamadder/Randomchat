import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const joinQueue = mutation({
  args: {
    wantsVideo: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // First, leave any existing session
    const existingSession = await ctx.db
      .query("chatSessions")
      .filter((q) => 
        q.or(
          q.eq(q.field("userA"), userId),
          q.eq(q.field("userB"), userId)
        )
      )
      .filter((q) => q.eq(q.field("active"), true))
      .unique();

    if (existingSession) {
      await ctx.db.patch(existingSession._id, { active: false });
    }

    // Clean up any existing waiting entries
    const existingWaiting = await ctx.db
      .query("waitingUsers")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();
    
    for (const waiting of existingWaiting) {
      await ctx.db.delete(waiting._id);
    }

    // Find someone else waiting who also wants video if we want video
    const match = await ctx.db
      .query("waitingUsers")
      .filter((q) => q.neq(q.field("userId"), userId))
      .filter((q) => args.wantsVideo ? q.eq(q.field("wantsVideo"), true) : true)
      .first();

    if (match) {
      // Create session with matched user
      await ctx.db.insert("chatSessions", {
        userA: userId,
        userB: match.userId,
        active: true,
        hasVideo: args.wantsVideo && match.wantsVideo,
      });
      // Remove matched user from waiting
      await ctx.db.delete(match._id);
    } else {
      // No match found, add self to waiting
      await ctx.db.insert("waitingUsers", {
        userId,
        joinedAt: Date.now(),
        wantsVideo: args.wantsVideo,
      });
    }
  },
});

export const getCurrentSession = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    return await ctx.db
      .query("chatSessions")
      .filter((q) => 
        q.or(
          q.eq(q.field("userA"), userId),
          q.eq(q.field("userB"), userId)
        )
      )
      .filter((q) => q.eq(q.field("active"), true))
      .unique();
  },
});

export const sendMessage = mutation({
  args: {
    content: v.string(),
    sessionId: v.id("chatSessions"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.active) throw new Error("Invalid session");
    if (session.userA !== userId && session.userB !== userId) {
      throw new Error("Not in this session");
    }

    await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      content: args.content,
      authorId: userId,
    });
  },
});

export const getMessages = query({
  args: {
    sessionId: v.id("chatSessions"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.active) return [];
    if (session.userA !== userId && session.userB !== userId) return [];

    return await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("asc")
      .collect();
  },
});

export const sendSignal = mutation({
  args: {
    sessionId: v.id("chatSessions"),
    toUserId: v.id("users"),
    type: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.active || !session.hasVideo) {
      throw new Error("Invalid session");
    }
    if (session.userA !== userId && session.userB !== userId) {
      throw new Error("Not in this session");
    }
    if (args.toUserId !== session.userA && args.toUserId !== session.userB) {
      throw new Error("Invalid target user");
    }

    await ctx.db.insert("rtcSignaling", {
      sessionId: args.sessionId,
      fromUserId: userId,
      toUserId: args.toUserId,
      type: args.type,
      payload: args.payload,
    });
  },
});

export const getSignals = query({
  args: {
    sessionId: v.id("chatSessions"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const session = await ctx.db.get(args.sessionId);
    if (!session || !session.active || !session.hasVideo) return [];
    if (session.userA !== userId && session.userB !== userId) return [];

    return await ctx.db
      .query("rtcSignaling")
      .withIndex("by_session_and_to", (q) => 
        q.eq("sessionId", args.sessionId).eq("toUserId", userId)
      )
      .collect();
  },
});

export const leaveChat = mutation({
  args: {
    sessionId: v.id("chatSessions"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    if (session.userA !== userId && session.userB !== userId) return;

    // End the session
    await ctx.db.patch(args.sessionId, { active: false });

    // Clean up any waiting entries
    const waiting = await ctx.db
      .query("waitingUsers")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();
    
    for (const entry of waiting) {
      await ctx.db.delete(entry._id);
    }
  },
});

export const isWaiting = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;

    const waiting = await ctx.db
      .query("waitingUsers")
      .filter((q) => q.eq(q.field("userId"), userId))
      .unique();

    return !!waiting;
  },
});

export const getDebugState = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const waiting = await ctx.db.query("waitingUsers").collect();
    const sessions = await ctx.db
      .query("chatSessions")
      .filter((q) => q.eq(q.field("active"), true))
      .collect();

    return {
      currentUserId: userId,
      waitingUsers: waiting,
      activeSessions: sessions,
    };
  },
});
