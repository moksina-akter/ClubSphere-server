require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRETS);
// const fs = require("fs");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://club-sphere-client-khaki.vercel.app",
    ],

    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// 🔥 VERY IMPORTANT LINE
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.cdbx9rd.mongodb.net/ClubSphereDb?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  const db = client.db("ClubSphereDb");
  const clubCollection = db.collection("club");
  const eventCollection = db.collection("events");
  const userCollection = db.collection("users");
  const paymentCollection = db.collection("payments");
  const registrationCollection = db.collection("eventRegistrations");
  const membershipsCollection = db.collection("memberships");

  // Get all clubs
  const clubs = await clubCollection.find({}).toArray();
  const events = await eventCollection.find({}).toArray();
  for (let event of events) {
    const club = clubs.find((c) => c.clubName === event.clubId); // event.clubId এখন string
    if (club) {
      await eventCollection.updateOne(
        { _id: event._id },
        { $set: { clubId: new ObjectId(club._id) } }
      );
      console.log(`Updated event ${event.title}`);
    }
  }
  const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      // ডাটাবেজে ইমেইল দিয়ে ইউজার খুঁজুন
      const user = await userCollection.findOne({ email: decoded.email });

      if (!user) {
        return res.status(403).json({ message: "User not found in database" });
      }

      req.decoded = user; // এখানে পুরো ইউজার অবজেক্ট সেট হচ্ছে
      next();
    } catch (err) {
      console.error("Token Verification Error:", err.message);
      return res.status(401).json({ message: "Invalid token" });
    }
  };

  const verifyAdmin = (req, res, next) => {
    if (req.decoded?.role !== "admin") {
      return res.status(403).json({ message: "Forbidden: Admin only" });
    }
    next();
  };
  const verifyManager = (req, res, next) => {
    // console.log(req.decoded.role);
    if (req.decoded.role !== "clubManager") {
      return res.status(403).json({ message: "Forbidden: Manager only" });
    }
    next();
  };
  app.post("/refresh-token", verifyToken, async (req, res) => {
    try {
      const uid = req.decoded.uid;
      const userRecord = await admin.auth().getUser(uid);
      const customClaims = userRecord.customClaims || {};

      const token = await admin.auth().createCustomToken(uid, customClaims);

      res.json({ token, role: customClaims.role || "member" });
    } catch (err) {
      console.error("Error refreshing token:", err);
      res.status(500).json({ message: "Token refresh failed" });
    }
  });
  // Users
  app.get("/users/:email", async (req, res) => {
    const email = req.params.email;
    const user = await userCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({
      name: user.name,
      email: user.email,
      role: user.role || "member",
      uid: user.uid || null,
      photoURL: user.photoURL,
      createdAt: user.createdAt,
    });
  });

  app.post("/users", async (req, res) => {
    const { email, uid, name, photoURL } = req.body;

    if (!email || !uid) {
      return res.status(400).json({ message: "Email & UID required" });
    }

    try {
      let user = await userCollection.findOne({ email });

      if (!user) {
        const result = await userCollection.insertOne({
          name: name || "",
          email,
          photoURL: photoURL || "",
          uid,
          role: "member",
          createdAt: new Date(),
        });

        user = await userCollection.findOne({ _id: result.insertedId });
      }

      res.status(201).json({
        message: "User created/fetched successfully",
        user,
      });
    } catch (err) {
      console.error("User save error:", err);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/club", async (req, res) => {
    const clubs = await clubCollection.find().toArray();
    res.json(clubs);
  });

  app.get("/club/:id", async (req, res) => {
    const id = req.params.id;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid club ID" });

    const club = await clubCollection.findOne({ _id: new ObjectId(id) });
    if (!club) return res.status(404).json({ message: "Club not found" });

    res.json(club);
  });

  app.get("/featured-clubs", async (req, res) => {
    const featured = await clubCollection
      .find({ status: "approved" })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    res.json(featured);
  });

  app.get("/events", async (req, res) => {
    const events = await eventCollection.find({}).toArray();
    res.json(events);
  });

  app.get("/events/:id", async (req, res) => {
    const id = req.params.id;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid event ID" });

    const event = await eventCollection.findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).json({ message: "Event not found" });

    res.json(event);
  });

  app.post("/events/create-checkout-session", verifyToken, async (req, res) => {
    const { eventId } = req.body;

    const event = await eventCollection.findOne({ _id: new ObjectId(eventId) });
    if (!event) return res.status(404).json({ message: "Event not found" });

    if (!event.isPaid || event.eventFee <= 0) {
      return res.status(400).json({ message: "This is a free event" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: event.eventFee * 100,
            product_data: { name: event.title },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        eventId: event._id.toString(),
        clubId: event.clubId.toString(),
        userEmail: req.decoded.email,
      },
      customer_email: req.decoded.email,
      success_url: `${process.env.CLIENT_URL}/events/${event._id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/events/${event._id}`,
    });

    res.json({ url: session.url });
  });

  app.post("/events/:id/register", verifyToken, async (req, res) => {
    try {
      const event = await eventCollection.findOne({
        _id: new ObjectId(req.params.id),
      });

      if (!event) return res.status(404).json({ message: "Event not found" });

      const feeAmount = Number(event.eventFee ?? 0);
      const isPaidEvent = Boolean(event.isPaid) && feeAmount > 0;

      // Check if already registered
      const already = await registrationCollection.findOne({
        eventId: event._id,
        userEmail: req.decoded.email,
      });
      if (already) return res.status(400).json({ message: "Already joined" });

      // PAID EVENT → Stripe
      if (isPaidEvent) {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: feeAmount * 100,
                product_data: { name: event.title },
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          metadata: {
            eventId: event._id.toString(),
            clubId: event.clubId.toString(),
            userEmail: req.decoded.email,
          },
          customer_email: req.decoded.email,
          success_url: `${process.env.CLIENT_URL}/events/${event._id}?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/events/${event._id}`,
        });

        return res.json({ url: session.url });
      }

      // FREE EVENT → Direct registration
      const registration = await registrationCollection.insertOne({
        eventId: event._id,
        clubId: event.clubId,
        userEmail: req.decoded.email,
        status: "registered",
        registeredAt: new Date(),
      });

      res.json({ registration, message: "Successfully joined free event" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Event registration failed" });
    }
  });

  // STRIPE PAYMENT SUCCESS
  app.post("/events/payment-success", verifyToken, async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId)
        return res.status(400).json({ message: "Session ID missing" });

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid")
        return res.status(400).json({ message: "Payment not completed" });

      const { eventId, clubId, userEmail } = session.metadata;

      if (req.decoded.email !== userEmail)
        return res.status(403).json({ message: "Forbidden" });

      // Check if already registered
      const already = await registrationCollection.findOne({
        eventId: new ObjectId(eventId),
        userEmail,
      });
      if (already) return res.json({ registered: true });

      // Insert registration
      await registrationCollection.insertOne({
        eventId: new ObjectId(eventId),
        clubId: new ObjectId(clubId),
        userEmail,
        paymentId: session.payment_intent,
        status: "registered",
        registeredAt: new Date(),
      });

      // Insert payment
      await paymentCollection.insertOne({
        userEmail,
        eventId,
        amount: session.amount_total / 100,
        transactionId: session.payment_intent,
        type: "event",
        status: "paid",
        createdAt: new Date(),
      });

      res.json({ registered: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Payment verification failed" });
    }
  });

  app.post("/member/join", verifyToken, async (req, res) => {
    const userEmail = req.decoded.email;
    const { clubId } = req.body;
    const exists = await membershipsCollection.findOne({
      userEmail,
      clubId,
      status: "active",
    });

    if (exists) {
      return res.status(400).json({ message: "Already a member" });
    }
    const club = await clubCollection.findOne({ _id: new ObjectId(clubId) });
    if (!club) return res.status(404).json({ message: "Club not found" });

    if (club.membershipFee > 0) {
      const amount = parseInt(club.membershipFee) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: { name: `${club.clubName} Membership Fee` },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: { clubId, clubName: club.clubName, userEmail },
        customer_email: userEmail,
        success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/dashboard/payment-cancelled`,
      });
      return res.json({ url: session.url });
    }

    const now = new Date();
    const expiryDate = new Date(now.setFullYear(now.getFullYear() + 1));
    const membershipData = {
      userEmail,
      clubId,
      status: "active",
      paymentId: null,
      joinedAt: new Date(),
      expiryDate,
    };
    const result = await membershipsCollection.insertOne(membershipData);
    res.status(201).json({ success: true, membership: result });
  });

  app.get("/payments", verifyToken, async (req, res) => {
    const email = req.query.email;
    const result = email
      ? await paymentCollection.find({ userEmail: email }).toArray()
      : [];
    res.json(result);
  });

  app.post("/payment-success", verifyToken, async (req, res) => {
    try {
      const sessionId = req.query.session_id;
      if (!sessionId) {
        return res.status(400).json({ message: "Session id missing" });
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid") {
        return res.status(400).json({ success: false });
      }

      const { clubId, clubName, userEmail } = session.metadata;
      const transactionId = session.payment_intent;

      // 🔒 token-email match
      if (req.decoded.email !== userEmail) {
        return res.status(403).json({ message: "Forbidden" });
      }

      // ✅ payment duplicate check (FIRST)
      const paid = await paymentCollection.findOne({ transactionId });
      if (paid) {
        return res.json({ success: true, message: "Already processed" });
      }

      // ✅ membership duplicate check
      const exists = await membershipsCollection.findOne({
        userEmail,
        clubId: new ObjectId(clubId),
      });
      if (exists) {
        return res.json({ message: "Already a member" });
      }

      const now = new Date();
      const expiryDate = new Date(now.setFullYear(now.getFullYear() + 1));

      // ✅ membership insert
      await membershipsCollection.insertOne({
        userEmail,
        clubId: new ObjectId(clubId), // 🔥 FIXED
        status: "active",
        paymentId: transactionId,
        joinedAt: new Date(),
        expiryDate,
      });

      // ✅ payment insert
      await paymentCollection.insertOne({
        userEmail,
        amount: session.amount_total / 100, // 🔥 FIXED
        clubId: new ObjectId(clubId),
        clubName,
        type: "membership",
        transactionId,
        status: "paid",
        createdAt: new Date(),
      });

      res.json({ success: true, transactionId });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Payment processing failed" });
    }
  });

  app.post("/create-checkout-session", verifyToken, async (req, res) => {
    const { clubId, clubName, membershipFee } = req.body;
    const amount = parseInt(membershipFee) * 100;
    const userEmail = req.decoded.email;
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amount,
            product_data: { name: `${clubName} Membership Fee` },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: { clubId, clubName, userEmail },
      customer_email: userEmail,
      success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  });

  // PATCH approve member
  app.patch(
    "/members/approve/:id",
    verifyToken,
    verifyManager,
    async (req, res) => {
      try {
        const memberId = req.params.id;
        const db = client.db("ClubSphereDb");

        if (!ObjectId.isValid(memberId))
          return res.status(400).json({ message: "Invalid member ID" });

        const result = await db
          .collection("memberships")
          .updateOne(
            { _id: new ObjectId(memberId) },
            { $set: { status: "active" } }
          );

        if (result.matchedCount === 0)
          return res.status(404).json({ message: "Member not found" });

        res.json({ message: "Member approved successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    }
  );

  // DELETE remove member
  app.delete("/members/:id", verifyToken, verifyManager, async (req, res) => {
    try {
      const memberId = req.params.id;
      const db = client.db("ClubSphereDb");

      if (!ObjectId.isValid(memberId))
        return res.status(400).json({ message: "Invalid member ID" });

      const result = await db
        .collection("memberships")
        .deleteOne({ _id: new ObjectId(memberId) });

      if (result.deletedCount === 0)
        return res.status(404).json({ message: "Member not found" });

      res.json({ message: "Member removed successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/member-overview", verifyToken, async (req, res) => {
    const email = req.decoded.email;

    // Active memberships
    const clubsJoined = await membershipsCollection.countDocuments({
      userEmail: email,
      status: "active",
    });

    // Registered events
    const eventsRegistered = await registrationCollection.countDocuments({
      userEmail: email,
    });

    // Upcoming events (with club name & event date)
    const regs = await registrationCollection
      .find({ userEmail: email })
      .toArray();

    const upcomingEvents = await Promise.all(
      regs.map(async (reg) => {
        const event = ObjectId.isValid(reg.eventId)
          ? await eventCollection.findOne({ _id: new ObjectId(reg.eventId) })
          : null;
        const club = ObjectId.isValid(reg.clubId)
          ? await clubCollection.findOne({ _id: new ObjectId(reg.clubId) })
          : null;

        return {
          _id: reg._id,
          eventTitle: event?.title || "Unknown Event",
          eventDate: event?.eventDate ? new Date(event.eventDate) : null,
          clubName: club?.clubName || "Unknown Club",
          status: reg.status,
        };
      })
    );

    res.json({
      totalClubsJoined: clubsJoined,
      totalEventsRegistered: eventsRegistered,
      upcomingEvents,
    });
  });

  app.get("/member/my-clubs", verifyToken, async (req, res) => {
    const email = req.decoded.email;

    // memberships fetch
    const memberships = await membershipsCollection
      .find({ userEmail: email })
      .toArray();

    const clubs = await clubCollection
      .find({ _id: { $in: memberships.map((m) => new ObjectId(m.clubId)) } })
      .toArray();

    const result = memberships.map((membership) => {
      const club = clubs.find(
        (c) => c._id.toString() === membership.clubId.toString()
      );
      return {
        _id: membership._id,
        clubId: membership.clubId,
        clubName: club?.clubName || "Unknown Club",
        location: club?.location || "N/A",
        membershipFee: club?.membershipFee || 0,
        status: membership.status,
        expiryDate: membership.expiryDate,
      };
    });

    res.json(result);
  });

  app.get("/member/my-events", verifyToken, async (req, res) => {
    const email = req.decoded.email;
    const regs = await registrationCollection
      .find({ userEmail: email })
      .toArray();

    const events = await Promise.all(
      regs.map(async (reg) => {
        const event = ObjectId.isValid(reg.eventId)
          ? await eventCollection.findOne({ _id: new ObjectId(reg.eventId) })
          : null;
        const club = ObjectId.isValid(reg.clubId)
          ? await clubCollection.findOne({ _id: new ObjectId(reg.clubId) })
          : null;
        return {
          _id: reg._id,
          eventTitle: event?.title || "Unknown Event",
          eventDate: event?.eventDate || null,
          clubName: event?.location || "Unknown Club",
          status: reg.status,
        };
      })
    );

    res.json(events);
  });

  app.get("/member/upcoming-events", verifyToken, async (req, res) => {
    const email = req.decoded.email;
    const memberships = await membershipsCollection
      .find({ userEmail: email, status: "active" })
      .toArray();
    const clubIds = memberships.map((m) => new ObjectId(m.clubId));

    const today = new Date();
    const events = await eventCollection
      .find({ clubId: { $in: clubIds }, eventDate: { $gte: today } })
      .sort({ eventDate: 1 })
      .toArray();

    const clubs = await clubCollection
      .find({ _id: { $in: clubIds } })
      .toArray();

    const result = events.map((event) => {
      const club = clubs.find(
        (c) => c._id.toString() === event.clubId.toString()
      );
      return { ...event, clubName: club?.clubName || "Unknown Club" };
    });

    res.json(result);
  });

  app.get("/member/payments", verifyToken, async (req, res) => {
    try {
      const email = req.decoded.email;
      if (!email) return res.status(400).json({ message: "Email required" });

      const payments = await paymentCollection
        .find({ userEmail: email })
        .sort({ createdAt: -1 }) // latest first
        .toArray();

      res.json(payments);
    } catch (err) {
      console.error("Error fetching member payments:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/manager/overview", verifyToken, verifyManager, async (req, res) => {
    try {
      const email = req.decoded.email;

      const clubs = await clubCollection
        .find({ managerEmail: email })
        .toArray();
      const clubIds = clubs.map((c) => c._id);

      const totalMembers = await membershipsCollection.countDocuments({
        clubId: { $in: clubIds },
      });

      const totalEvents = await eventCollection.countDocuments({
        clubId: { $in: clubIds },
      });

      const payments = await paymentCollection
        .find({ clubId: { $in: clubIds } })
        .toArray();

      const totalPayments = payments.reduce(
        (sum, p) => sum + (p.amount || 0),
        0
      );

      res.json({
        totalClubs: clubs.length,
        totalMembers,
        totalEvents,
        totalPayments,
      });
    } catch (err) {
      console.error("Manager Overview Error:", err);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.post(
    "/manager/create-club",
    verifyToken,
    verifyManager,
    async (req, res) => {
      try {
        const { clubName, location, description, membershipFee, bannerImage } =
          req.body;
        const managerEmail = req.decoded.email;

        const newClub = {
          clubName,
          location,
          description: description || "",
          membershipFee: membershipFee || 0,
          managerEmail,
          bannerImage: bannerImage || "",
          status: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await clubCollection.insertOne(newClub);
        res.json({ success: true, club: result });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    }
  );

  // UPDATE existing club
  app.put(
    "/manager/my-clubs/:id",
    verifyToken,
    verifyManager,
    async (req, res) => {
      try {
        const clubId = req.params.id;
        const updateData = req.body;

        const club = await clubCollection.findOne({
          _id: new ObjectId(clubId),
        });
        if (!club) return res.status(404).json({ message: "Club not found" });

        if (req.decoded.email !== club.managerEmail)
          return res.status(403).json({ message: "Forbidden" });

        await clubCollection.updateOne(
          { _id: new ObjectId(clubId) },
          { $set: updateData }
        );
        res.json({ success: true, message: "Club updated" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    }
  );

  // DELETE club
  app.delete(
    "/manager/my-clubs/:id",
    verifyToken,
    verifyManager,
    async (req, res) => {
      try {
        const clubId = req.params.id;
        const club = await clubCollection.findOne({
          _id: new ObjectId(clubId),
        });
        if (!club) return res.status(404).json({ message: "Club not found" });

        if (req.decoded.email !== club.managerEmail)
          return res.status(403).json({ message: "Forbidden" });

        await clubCollection.deleteOne({ _id: new ObjectId(clubId) });
        res.json({ success: true, message: "Club deleted" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    }
  );

  app.get("/manager/my-clubs", verifyToken, async (req, res) => {
    try {
      const managerEmail = req.decoded.email;

      const clubs = await clubCollection
        .find({
          managerEmail,
          status: { $regex: /^approved$/i }, // case-insensitive
        })
        .toArray();

      res.json(clubs);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch clubs" });
    }
  });

  app.post(
    "/manager/create-event",
    verifyToken,
    verifyManager,
    async (req, res) => {
      try {
        const {
          clubId,
          title,
          description,
          eventDate,
          location,
          isPaid,
          eventFee,
        } = req.body;

        const club = await clubCollection.findOne({
          _id: new ObjectId(clubId),
          managerEmail: req.decoded.email,
          status: { $regex: /^approved$/i },
        });

        if (!club) return res.status(403).json({ message: "Invalid club" });

        const newEvent = {
          clubId: club._id,
          title,
          description: description || "",
          eventDate: new Date(eventDate),
          location,
          isPaid: !!isPaid,
          eventFee: isPaid ? Number(eventFee) : 0,
          createdAt: new Date(),
        };

        const result = await eventCollection.insertOne(newEvent);
        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to create event" });
      }
    }
  );

  app.get(
    "/manager/my-events",
    verifyToken,
    verifyManager,
    async (req, res) => {
      try {
        const managerEmail = req.decoded.email;
        const clubs = await clubCollection.find({ managerEmail }).toArray();

        const clubIds = clubs.map((c) => c._id);
        const events = await eventCollection
          .find({ clubId: { $in: clubIds } })
          .toArray();

        res.json(events);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch events" });
      }
    }
  );
  app.put(
    "/manager/my-events/:id",
    verifyToken,
    verifyManager,
    async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;

      const event = await eventCollection.findOne({ _id: new ObjectId(id) });
      if (!event) return res.status(404).send("Event not found");

      const club = await clubCollection.findOne({
        _id: new ObjectId(event.clubId),
      });
      if (req.decoded.email !== club.managerEmail)
        return res.status(403).send("Forbidden");

      await eventCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData }
      );
      res.json({ message: "Event updated" });
    }
  );
  app.delete(
    "/manager/my-events/:id",
    verifyToken,
    verifyManager,
    async (req, res) => {
      const { id } = req.params;
      const event = await eventCollection.findOne({ _id: new ObjectId(id) });
      if (!event) return res.status(404).send("Event not found");

      const club = await clubCollection.findOne({
        _id: new ObjectId(event.clubId),
      });
      if (req.decoded.email !== club.managerEmail)
        return res.status(403).send("Forbidden");

      await eventCollection.deleteOne({ _id: new ObjectId(id) });
      res.json({ message: "Event deleted" });
    }
  );

  app.get("/manager/members", verifyToken, verifyManager, async (req, res) => {
    try {
      const managerEmail = req.decoded.email;
      const db = client.db("ClubSphereDb");

      // Fetch approved clubs of this manager
      const clubs = await db
        .collection("club")
        .find({ managerEmail, status: "approved" })
        .toArray();

      if (!clubs.length) return res.json([]);

      const clubIds = clubs.map((c) => c._id.toString()); // string for memberships

      // Fetch memberships
      const memberships = await db
        .collection("memberships")
        .find({ clubId: { $in: clubIds } })
        .toArray();

      const members = memberships.map((m) => {
        const club = clubs.find((c) => c._id.toString() === m.clubId);
        return {
          _id: m._id,
          userEmail: m.userEmail,
          clubName: club?.clubName || "Unknown Club",
          status: m.status,
          joinedAt: m.joinedAt,
          expiryDate: m.expiryDate || null,
        };
      });

      res.json(members);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  // GET Event Registrations for Manager
  app.get("/manager/event-registrations", verifyToken, async (req, res) => {
    try {
      const managerEmail = req.decoded.email;
      if (req.decoded.role !== "clubManager")
        return res.status(403).send("Forbidden");

      const db = client.db("ClubSphereDb");

      // Fetch manager's approved clubs
      const clubs = await db
        .collection("club")
        .find({ managerEmail, status: "approved" })
        .toArray();

      if (!clubs.length) return res.json([]);

      // Use clubName because events.collection uses string clubId
      const clubNames = clubs.map((c) => c.clubName);

      // Fetch events for these clubs
      const events = await db
        .collection("events")
        .find({ clubId: { $in: clubNames } })
        .toArray();

      if (!events.length) return res.json([]);

      const eventIds = events.map((e) => e._id.toString());

      // Fetch registrations
      const registrations = await db
        .collection("eventRegistrations")
        .find({ eventId: { $in: eventIds } })
        .toArray();

      // Attach event title and clubName
      const registrationsWithEvent = registrations.map((reg) => {
        const event = events.find(
          (e) => e._id.toString() === reg.eventId.toString()
        );
        return {
          _id: reg._id,
          userEmail: reg.userEmail,
          status: reg.status,
          registeredAt: reg.registeredAt,
          eventTitle: event?.title || "Unknown Event",
          clubName: event?.clubId || "Unknown Club",
        };
      });

      res.json(registrationsWithEvent);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  // PUT Update Event Registration Status
  app.put("/manager/event-registrations/:id", verifyToken, async (req, res) => {
    try {
      const registrationId = req.params.id;
      const { status } = req.body;
      const db = client.db("ClubSphereDb");

      const reg = await db
        .collection("eventRegistrations")
        .findOne({ _id: new ObjectId(registrationId) });
      if (!reg) return res.status(404).send("Registration not found");

      // Find club to verify manager
      const club = await db
        .collection("club")
        .findOne({ clubName: reg.clubId });
      if (!club || club.managerEmail !== req.decoded.email)
        return res.status(403).send("Forbidden");

      await db
        .collection("eventRegistrations")
        .updateOne({ _id: new ObjectId(registrationId) }, { $set: { status } });

      res.json({ message: "Status updated successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.post(
    "/admin/promote-user/:uid",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      const uid = req.params.uid;

      // Firebase custom claim
      await admin.auth().setCustomUserClaims(uid, { role: "clubManager" });
      await userCollection.updateOne(
        { uid },
        { $set: { role: "clubManager" } }
      );

      res.json({ message: "Manager approved" });
    }
  );

  app.post(
    "/admin/set-admin/:uid",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      if (req.decoded.role !== "admin") {
        return res.status(403).json({ message: "Forbidden" });
      }

      const uid = req.params.uid;

      await admin.auth().setCustomUserClaims(uid, { role: "admin" });
      await userCollection.updateOne({ uid }, { $set: { role: "admin" } });

      res.json({ message: "Admin role assigned" });
    }
  );

  app.get("/admin/overview", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const totalUsers = await userCollection.countDocuments();
      const totalClubs = await clubCollection.countDocuments();

      const pendingClubs = await clubCollection.countDocuments({
        status: "pending",
      });
      const approvedClubs = await clubCollection.countDocuments({
        status: "approved",
      });
      const rejectedClubs = await clubCollection.countDocuments({
        status: "rejected",
      });

      const totalEvents = await eventCollection.countDocuments();
      const totalMembers = await membershipsCollection.countDocuments();

      const payments = await paymentCollection.find().toArray();
      const totalPayments = payments.reduce(
        (sum, p) => sum + (p.amount || 0),
        0
      );

      res.json({
        totalUsers,
        totalClubs,
        pendingClubs,
        approvedClubs,
        rejectedClubs,
        totalEvents,
        totalMembers,
        totalPayments,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
    const users = await userCollection.find().toArray();
    res.json(users);
  });

  app.put("/admin/users/:uid", verifyToken, verifyAdmin, async (req, res) => {
    const email = req.decoded.email;
    const adminUser = await userCollection.findOne({ email });

    if (!adminUser || adminUser.role !== "admin") {
      return res.status(403).json({ message: "Forbidden: Admin only" });
    }

    const { uid } = req.params;
    const { role } = req.body;

    await admin.auth().setCustomUserClaims(uid, { role });
    const result = await userCollection.updateOne({ uid }, { $set: { role } });

    res.json({ message: "User role updated", result });
  });

  app.delete(
    "/admin/users/:uid",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      if (req.decoded.role !== "admin") {
        return res.status(403).json({ message: "Forbidden: Admin only" });
      }

      const { uid } = req.params;

      // Delete from Firebase
      await admin.auth().deleteUser(uid);

      // Delete from MongoDB
      const result = await userCollection.deleteOne({ uid });

      res.json({ message: "User deleted successfully", result });
    }
  );

  app.patch("/admin/clubs/:id", verifyToken, verifyAdmin, async (req, res) => {
    if (req.decoded.role !== "admin")
      return res.status(403).json({ message: "Forbidden" });
    const { id } = req.params;
    const { status } = req.body;
    const result = await clubCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );
    res.json(result);
  });

  app.get("/admin/payments", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const payments = await paymentCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.json(payments);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  // Fetch all clubs
  app.get("/admin/clubs", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const clubs = await clubCollection.find().toArray();
      res.json(clubs);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  // Test
  // await client.db("admin").command({ ping: 1 });
  console.log("Connected to MongoDB successfully!");
}
app.get("/", (req, res) => res.send("My ClubSphere server is running..."));
run();

app.listen(port, () => console.log(`Server running on port ${port}`));
