require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRETS);
const fs = require("fs");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// Firebase Admin initialize
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
      const user = await userCollection.findOne({ email: decoded.email });
      if (!user) return res.status(403).json({ message: "Forbidden" });

      req.decoded = user;
      next();
    } catch (err) {
      console.error(err);
      return res.status(401).json({ message: "Invalid or expired token" });
    }
  };
  // Verify admin role
  const verifyAdmin = (req, res, next) => {
    if (req.decoded.role !== "admin") {
      console.log("Forbidden! decoded token:", req.decoded);
      return res.status(403).json({ message: "Forbidden: Admin only" });
    }
    next();
  };
  const verifyManager = (req, res, next) => {
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

  app.post("/users", verifyToken, async (req, res) => {
    const { email, uid, name, photoURL } = req.body;
    if (!email || !uid)
      return res.status(400).json({ message: "Email & UID required" });

    let firebaseUser;
    try {
      firebaseUser = await admin.auth().getUser(uid);

      let user = await userCollection.findOne({ uid });
      let result;
      if (!user) {
        console.log("5. User not found in MongoDB. Inserting...");
        result = await userCollection.insertOne({
          name: name || firebaseUser?.displayName || "",
          email,
          photoURL: photoURL || firebaseUser?.photoURL || "",
          uid,
          role: "member",
          createdAt: new Date(),
        });
        console.log("6. Insertion successful. ID:", result.insertedId);
        user = await userCollection.findOne({ _id: result.insertedId });
      } else {
        console.log("User already exists in MongoDB:", user._id);
      }

      res
        .status(201)
        .json({ message: "User created/fetched successfully", user });
    } catch (err) {
      console.error("Error in /users route:", err);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/club", async (req, res) => {
    const clubs = await clubCollection.find({ status: "approved" }).toArray();
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

  // Events
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

  app.post("/events/:id/register", verifyToken, async (req, res) => {
    const eventId = req.params.id;
    const userEmail = req.decoded.email;
    const { paymentId } = req.body;

    if (!ObjectId.isValid(eventId))
      return res.status(400).json({ message: "Invalid event ID" });

    const event = await eventCollection.findOne({ _id: new ObjectId(eventId) });
    if (!event) return res.status(404).json({ message: "Event not found" });

    const registration = await registrationCollection.insertOne({
      eventId: new ObjectId(eventId),
      clubId: event.clubId,
      userEmail,
      status: "registered",
      paymentId: paymentId || null,
      registeredAt: new Date(),
    });

    res.status(201).json({ message: "Registered successfully", registration });
  });

  // Member join
  app.post("/member/join", verifyToken, async (req, res) => {
    const userEmail = req.decoded.email;
    const { clubId } = req.body;
    if (!clubId) return res.status(400).json({ message: "Club ID required" });

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

  // Payments
  app.get("/payments", verifyToken, async (req, res) => {
    const email = req.query.email;
    const result = email
      ? await paymentCollection.find({ userEmail: email }).toArray()
      : [];
    res.json(result);
  });

  app.post("/payment-success", async (req, res) => {
    const sessionId = req.query.session_id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return res.json({ success: false });

    const { clubId, clubName, userEmail } = session.metadata;
    const transactionId = session.payment_intent;

    const now = new Date();
    const expiryDate = new Date(now.setFullYear(now.getFullYear() + 1));

    const membershipData = {
      userEmail,
      clubId,
      status: "active",
      paymentId: transactionId,
      joinedAt: new Date(),
      expiryDate,
    };
    const membershipResult = await membershipsCollection.insertOne(
      membershipData
    );

    const paymentData = {
      userEmail,
      amount: session.amount_total,
      clubId,
      clubName,
      type: "membership",
      transactionId,
      status: session.payment_status,
      createdAt: new Date(),
    };
    const paymentResult = await paymentCollection.insertOne(paymentData);

    res.json({
      success: true,
      membership: membershipResult,
      payment: paymentResult,
      transactionId,
    });
  });

  // Stripe checkout session
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

  // Member overview
  app.get("/member-overview", verifyToken, async (req, res) => {
    const email = req.decoded.email;
    const memberships = await membershipsCollection
      .find({ userEmail: email, status: "active" })
      .toArray();
    const registrations = await registrationCollection
      .find({ userEmail: email, status: "registered" })
      .toArray();

    const upcomingEvents = await Promise.all(
      registrations.map(async (reg) => {
        const event = await eventCollection.findOne({
          _id: new ObjectId(reg.eventId),
        });
        if (new Date(event.eventDate) >= new Date()) {
          const club = await clubCollection.findOne({
            _id: new ObjectId(event.clubId),
          });
          return {
            eventTitle: event.title,
            eventDate: event.eventDate,
            clubName: club.clubName,
          };
        }
      })
    );

    res.json({
      totalClubsJoined: memberships.length,
      totalEventsRegistered: registrations.length,
      upcomingEvents: upcomingEvents.filter(Boolean),
    });
  });

  // My Clubs
  app.get("/member/my-clubs", verifyToken, async (req, res) => {
    const email = req.query.email;
    if (req.decoded.email !== email)
      return res.status(403).json({ message: "Forbidden" });

    const memberships = await membershipsCollection
      .find({ userEmail: email })
      .toArray();
    const clubs = await Promise.all(
      memberships.map(async (membership) => {
        const club = await clubCollection.findOne({
          _id: new ObjectId(membership.clubId),
        });
        return {
          ...membership,
          clubName: club?.clubName || "Unknown Club",
          location: club?.location || "N/A",
          membershipFee: club?.membershipFee || 0,
          expiryDate: membership.expiryDate,
        };
      })
    );
    res.json(clubs);
  });

  app.get("/member/my-events", verifyToken, async (req, res) => {
    try {
      const email = req.decoded.email;
      if (!email) return res.status(400).json({ message: "Email required" });

      const registrations = await registrationCollection
        .find({ userEmail: email })
        .toArray();

      const events = await Promise.all(
        registrations.map(async (reg) => {
          let event = null;
          let club = null;

          try {
            if (ObjectId.isValid(reg.eventId))
              event = await eventCollection.findOne({
                _id: new ObjectId(reg.eventId),
              });
          } catch {}

          try {
            if (ObjectId.isValid(reg.clubId))
              club = await clubCollection.findOne({
                _id: new ObjectId(reg.clubId),
              });
          } catch {}

          return {
            _id: reg._id,
            eventTitle: event?.title || "Unknown Event",
            eventDate: event?.eventDate || null,
            clubName: club?.clubName || "Unknown Club",
            status: reg.status,
          };
        })
      );

      res.json(events);
    } catch (err) {
      console.error("Error fetching my-events:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  });
  app.get("/member/upcoming-events", verifyToken, async (req, res) => {
    try {
      const email = req.query.email;
      if (!email) return res.status(400).json({ message: "Email required" });

      // 1️⃣ Active memberships
      const memberships = await membershipsCollection
        .find({ userEmail: email, status: "active" })
        .toArray();

      if (!memberships.length) return res.json([]);

      const clubIds = memberships.map((m) => new ObjectId(m.clubId));

      // 2️⃣ Upcoming events from those clubs
      const today = new Date();
      const events = await eventCollection
        .find({ clubId: { $in: clubIds }, eventDate: { $gte: today } })
        .sort({ eventDate: 1 }) // nearest events first
        .toArray();

      // 3️⃣ Attach clubName for frontend
      const clubs = await clubCollection
        .find({ _id: { $in: clubIds } })
        .toArray();

      const result = events.map((event) => {
        const club = clubs.find(
          (c) => c._id.toString() === event.clubId.toString()
        );
        return {
          ...event,
          clubName: club?.clubName || "Unknown Club",
        };
      });

      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Member payments
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

  // Manager overview
  app.get("/manager/overview", verifyToken, verifyManager, async (req, res) => {
    const email = req.decoded.email;
    const user = req.decoded;

    const clubs = await clubCollection.find({ managerEmail: email }).toArray();
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

    const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

    res.json({
      totalClubs: clubs.length,
      totalMembers,
      totalEvents,
      totalPayments,
    });
  });
  // GET all clubs managed by this manager
  app.get("/manager/my-clubs", verifyToken, verifyManager, async (req, res) => {
    try {
      const email = req.decoded.email;
      const clubs = await clubCollection
        .find({ managerEmail: email })
        .toArray();
      res.json(clubs);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });

  // CREATE new club
  app.post(
    "/manager/create-club",
    verifyToken,
    verifyManager,
    async (req, res) => {
      try {
        const { clubName, location, description, membershipFee } = req.body;
        const managerEmail = req.decoded.email;

        const newClub = {
          clubName,
          location,
          description: description || "",
          membershipFee: membershipFee || 0,
          managerEmail,
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

  app.get(
    "/manager/my-events",
    verifyToken,
    verifyManager,
    async (req, res) => {
      const email = req.query.email;
      if (req.decoded.email !== email || req.decoded.role !== "clubManager")
        return res.status(403).send("Forbidden");

      // Find all clubs by this manager
      const clubs = await clubCollection
        .find({ managerEmail: email })
        .toArray();
      const clubIds = clubs.map((c) => c._id);

      // Fetch events for these clubs
      const events = await eventCollection
        .find({ clubId: { $in: clubIds } })
        .toArray();
      res.json(events);
    }
  );

  // Create event
  app.post(
    "/manager/create-event",
    verifyToken,
    verifyManager,
    async (req, res) => {
      const {
        title,
        description,
        eventDate,
        location,
        isPaid,
        eventFee,
        managerEmail,
      } = req.body;

      if (req.decoded.role !== "clubManager")
        return res.status(403).send("Forbidden");

      const { clubId } = req.body;
      const club = await clubCollection.findOne({
        _id: new ObjectId(clubId),
        managerEmail: req.decoded.email,
      });

      if (!club) return res.status(403).send("Invalid club");

      const newEvent = {
        clubId: club._id,
        title,
        description,
        eventDate: new Date(eventDate),
        location,
        isPaid,
        eventFee: isPaid ? eventFee : 0,
        createdAt: new Date(),
      };

      const result = await eventCollection.insertOne(newEvent);
      res.json(result);
    }
  );
  // Get registrations for manager's events
  app.get("/event-registrations", verifyToken, async (req, res) => {
    const email = req.query.email;
    if (req.decoded.email !== email || req.decoded.role !== "clubManager")
      return res.status(403).send("Forbidden");

    // Get manager's clubs
    const clubs = await clubCollection.find({ managerEmail: email }).toArray();
    const clubIds = clubs.map((c) => c._id);

    // Get events for these clubs
    const events = await eventCollection
      .find({ clubId: { $in: clubIds } })
      .toArray();
    const eventIds = events.map((e) => e._id);

    // Get registrations for these events
    const registrations = await registrationCollection
      .find({ eventId: { $in: eventIds } })
      .toArray();

    // Add event title for display
    const registrationsWithEvent = registrations.map((reg) => {
      const event = events.find(
        (e) => e._id.toString() === reg.eventId.toString()
      );
      return {
        ...reg,
        eventTitle: event?.title || "Unknown Event",
      };
    });

    res.json(registrationsWithEvent);
  });

  // Update registration status
  app.put("/manager/event-registrations/:id", verifyToken, async (req, res) => {
    const registrationId = req.params.id;
    const { status } = req.body;

    const reg = await registrationCollection.findOne({
      _id: new ObjectId(registrationId),
    });

    if (!reg) return res.status(404).send("Registration not found");

    // Check if manager owns the club
    const club = await clubCollection.findOne({
      _id: new ObjectId(reg.clubId),
    });
    if (req.decoded.email !== club.managerEmail)
      return res.status(403).send("Forbidden");

    const result = await registrationCollection.updateOne(
      { _id: new ObjectId(registrationId) },
      { $set: { status } }
    );
    res.json(result);
  });

  //admin approved
  app.post(
    "/admin/approve-manager/:uid",
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
  await client.db("admin").command({ ping: 1 });
  console.log("Connected to MongoDB successfully!");
}

run();

app.get("/", (req, res) => res.send("My ClubSphere server is running..."));
app.listen(port, () => console.log(`Server running on port ${port}`));
