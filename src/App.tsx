import { Authenticated, Unauthenticated, useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { SignInForm } from "./SignInForm";
import { SignOutButton } from "./SignOutButton";
import { Toaster } from "sonner";
import { useState, useRef, useEffect } from "react";
import { Doc, Id } from "../convex/_generated/dataModel";

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-sm p-4 flex justify-between items-center border-b">
        <h2 className="text-xl font-semibold accent-text">Random Video Chat</h2>
        <SignOutButton />
      </header>
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-2xl mx-auto">
          <Content />
        </div>
      </main>
      <Toaster />
    </div>
  );
}

function Content() {
  const loggedInUser = useQuery(api.auth.loggedInUser);
  const debugState = useQuery(api.chat.getDebugState);

  if (loggedInUser === undefined) {
    return (
      <div className="flex justify-center items-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="text-center">
        <h1 className="text-5xl font-bold accent-text mb-4">Random Video Chat</h1>
        <Authenticated>
          <ChatInterface userId={loggedInUser?._id} />
          {debugState && (
            <div className="mt-4 text-left text-sm text-gray-500 border-t pt-4">
              <p>Debug Info:</p>
              <pre className="overflow-auto">
                {JSON.stringify(debugState, null, 2)}
              </pre>
            </div>
          )}
        </Authenticated>
        <Unauthenticated>
          <p className="text-xl text-slate-600">Sign in to start chatting</p>
          <SignInForm />
        </Unauthenticated>
      </div>
    </div>
  );
}

type Message = Doc<"messages">;
type Signal = Doc<"rtcSignaling">;
type Session = Doc<"chatSessions">;

function ChatInterface({ userId }: { userId: string | undefined }) {
  const session = useQuery(api.chat.getCurrentSession) as Session | null | undefined;
  const isWaiting = useQuery(api.chat.isWaiting);
  const joinQueue = useMutation(api.chat.joinQueue);
  const leaveChat = useMutation(api.chat.leaveChat);
  const messages = useQuery(api.chat.getMessages, 
    session ? { sessionId: session._id } : "skip"
  ) as Message[] | undefined;
  const signals = useQuery(api.chat.getSignals,
    session?.hasVideo ? { sessionId: session._id } : "skip"
  ) as Signal[] | undefined;
  const sendSignal = useMutation(api.chat.sendSignal);

  const [newMessage, setNewMessage] = useState("");
  const sendMessage = useMutation(api.chat.sendMessage);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const [wantsVideo, setWantsVideo] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle WebRTC setup when session changes
  useEffect(() => {
    if (!session?.hasVideo || !userId || !session) return;

    const otherUserId = session.userA === userId ? session.userB : session.userA;
    const isInitiator = session.userA === userId;
    const currentSession = session; // Capture for closure

    async function setupWebRTC() {
      try {
        // Get user media
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Create peer connection
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        peerConnectionRef.current = pc;

        // Add local stream
        stream.getTracks().forEach(track => {
          pc.addTrack(track, stream);
        });

        // Handle remote stream
        pc.ontrack = (event) => {
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        };

        // Handle ICE candidates
        pc.onicecandidate = async (event) => {
          if (event.candidate) {
            await sendSignal({
              sessionId: currentSession._id,
              toUserId: otherUserId,
              type: "ice-candidate",
              payload: JSON.stringify(event.candidate),
            });
          }
        };

        // If we're the initiator, create and send the offer
        if (isInitiator) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal({
            sessionId: currentSession._id,
            toUserId: otherUserId,
            type: "offer",
            payload: JSON.stringify(offer),
          });
        }
      } catch (err) {
        console.error("Error setting up WebRTC:", err);
      }
    }

    setupWebRTC();

    return () => {
      // Cleanup
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }
    };
  }, [session?.hasVideo, userId, session?._id]);

  // Handle incoming WebRTC signals
  useEffect(() => {
    if (!signals || !session || !userId) return;

    const currentSession = session; // Capture for closure

    async function handleSignal(signal: Signal) {
      const pc = peerConnectionRef.current;
      if (!pc) return;

      const otherUserId = currentSession.userA === userId ? currentSession.userB : currentSession.userA;

      try {
        if (signal.type === "offer") {
          const offer = JSON.parse(signal.payload);
          await pc.setRemoteDescription(offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await sendSignal({
            sessionId: currentSession._id,
            toUserId: otherUserId,
            type: "answer",
            payload: JSON.stringify(answer),
          });
        } else if (signal.type === "answer") {
          const answer = JSON.parse(signal.payload);
          await pc.setRemoteDescription(answer);
        } else if (signal.type === "ice-candidate") {
          const candidate = JSON.parse(signal.payload);
          await pc.addIceCandidate(candidate);
        }
      } catch (err) {
        console.error("Error handling signal:", err);
      }
    }

    signals.forEach(handleSignal);
  }, [signals, session, userId]);

  if (isWaiting) {
    return (
      <div className="text-center">
        <p className="text-xl mb-4">Looking for someone to chat with...</p>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto"></div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-col gap-4 items-center">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="video-toggle"
            checked={wantsVideo}
            onChange={(e) => setWantsVideo(e.target.checked)}
          />
          <label htmlFor="video-toggle">Enable video chat</label>
        </div>
        <button
          className="bg-indigo-500 text-white px-4 py-2 rounded hover:bg-indigo-600"
          onClick={() => joinQueue({ wantsVideo })}
        >
          Start Chatting
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {session.hasVideo && (
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="relative">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full rounded-lg bg-gray-900"
            />
            <p className="absolute bottom-2 left-2 text-white text-sm">You</p>
          </div>
          <div className="relative">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full rounded-lg bg-gray-900"
            />
            <p className="absolute bottom-2 left-2 text-white text-sm">Partner</p>
          </div>
        </div>
      )}
      <div className="flex flex-col h-[400px] border rounded-lg">
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-2">
            {messages?.map((message) => (
              <div
                key={message._id}
                className={`max-w-[80%] p-3 rounded-lg ${
                  message.authorId === userId
                    ? "bg-indigo-500 text-white self-end"
                    : "bg-gray-200 self-start"
                }`}
              >
                {message.content}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>
        <div className="border-t p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newMessage.trim() || !session) return;
              await sendMessage({
                content: newMessage,
                sessionId: session._id,
              });
              setNewMessage("");
            }}
            className="flex gap-2"
          >
            <input
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Type a message..."
              className="flex-1 border rounded px-3 py-2"
            />
            <button
              type="submit"
              disabled={!newMessage.trim()}
              className="bg-indigo-500 text-white px-4 py-2 rounded hover:bg-indigo-600 disabled:opacity-50"
            >
              Send
            </button>
          </form>
          <button
            onClick={() => session && leaveChat({ sessionId: session._id })}
            className="mt-2 text-red-500 hover:text-red-600"
          >
            Leave Chat
          </button>
        </div>
      </div>
    </div>
  );
}
