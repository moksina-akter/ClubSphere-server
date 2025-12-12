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

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded; // user info available
    next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.cdbx9rd.mongodb.net/?appName=Cluster0`;
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
  // Loop over events
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
  // Users
  app.get("/users/:email", async (req, res) => {
    const email = req.params.email;
    const user = await userCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({
      name: user.name,
      email: user.email,
      role: user.role || "member",
      photoURL: user.photoURL,
      createdAt: user.createdAt,
    });
  });

  app.post("/users", async (req, res) => {
    const user = req.body;
    if (!user?.email)
      return res.status(400).json({ message: "Email required" });

    const existingUser = await userCollection.findOne({ email: user.email });
    if (existingUser) return res.status(409).json({ message: "User exists" });

    const result = await userCollection.insertOne({
      ...user,
      role: "member",
      createdAt: new Date(),
    });
    res
      .status(201)
      .json({ message: "User created", userId: result.insertedId });
  });

  // Clubs
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

  app.post("/events/:id/register", async (req, res) => {
    const eventId = req.params.id;
    const { paymentId, userEmail } = req.body;

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
  app.get("/payments", async (req, res) => {
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
  app.post("/create-checkout-session", async (req, res) => {
    const { clubId, clubName, membershipFee } = req.body;
    const amount = parseInt(membershipFee) * 100;

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
      metadata: { clubId, clubName, userEmail: req.userEmail },
      customer_email: req.userEmail,
      success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  });
  // Member overview
  app.get("/member-overview", async (req, res) => {
    const email = req.query.email;
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

  app.get("/member/my-events", async (req, res) => {
    try {
      const email = req.query.email;
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
  app.get("/member/upcoming-events", async (req, res) => {
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
  app.get("/member/payments", async (req, res) => {
    try {
      const email = req.query.email;
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
  app.get("/manager/overview", verifyToken, async (req, res) => {
    const email = req.query.email;
    const user = req.decoded;

    if (user.role !== "manager") return res.status(403).send("Forbidden");

    const clubs = await clubCollection.find({ managerEmail: email }).toArray();
    const clubIds = clubs.map((c) => c._id);

    const totalMembers = await membershipsCollection.countDocuments({
      clubId: { $in: clubIds },
    });

    const totalEvents = await eventsCollection.countDocuments({
      clubId: { $in: clubIds },
    });

    const payments = await paymentsCollection
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

  // Get clubs managed by this manager
  app.get("/manager/my-clubs", verifyToken, async (req, res) => {
    const email = req.query.email;
    if (req.decoded.email !== email || req.decoded.role !== "manager")
      return res.status(403).send("Forbidden");

    const clubs = await clubCollection.find({ managerEmail: email }).toArray();
    res.json(clubs);
  });
  // Create a new club
  app.post("/manager/create-club", verifyToken, async (req, res) => {
    const { clubName, location, managerEmail } = req.body;
    if (req.decoded.email !== managerEmail || req.decoded.role !== "manager")
      return res.status(403).send("Forbidden");

    const newClub = {
      clubName,
      location,
      managerEmail,
      status: "pending", // admin will approve
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await clubCollection.insertOne(newClub);
    res.json(result);
  });
  // Get events for manager's clubs
  app.get("/manager/my-events", verifyToken, async (req, res) => {
    const email = req.query.email;
    if (req.decoded.email !== email || req.decoded.role !== "manager")
      return res.status(403).send("Forbidden");

    // Find all clubs by this manager
    const clubs = await clubCollection.find({ managerEmail: email }).toArray();
    const clubIds = clubs.map((c) => c._id);

    // Fetch events for these clubs
    const events = await eventCollection
      .find({ clubId: { $in: clubIds } })
      .toArray();
    res.json(events);
  });

  // Create event
  app.post("/manager/create-event", verifyToken, async (req, res) => {
    const {
      title,
      description,
      eventDate,
      location,
      isPaid,
      eventFee,
      managerEmail,
    } = req.body;

    if (req.decoded.email !== managerEmail || req.decoded.role !== "manager")
      return res.status(403).send("Forbidden");

    // Find a club by this manager to link
    const club = await clubCollection.findOne({ managerEmail });
    if (!club) return res.status(404).send("Club not found");

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
  });
  // Get registrations for manager's events
  app.get("/manager/event-registrations", verifyToken, async (req, res) => {
    const email = req.query.email;
    if (req.decoded.email !== email || req.decoded.role !== "manager")
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
    const registrations = await eventRegistrationsCollection
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

    const reg = await eventRegistrationsCollection.findOne({
      _id: new ObjectId(registrationId),
    });

    if (!reg) return res.status(404).send("Registration not found");

    // Check if manager owns the club
    const club = await clubCollection.findOne({
      _id: new ObjectId(reg.clubId),
    });
    if (req.decoded.email !== club.managerEmail)
      return res.status(403).send("Forbidden");

    const result = await eventRegistrationsCollection.updateOne(
      { _id: new ObjectId(registrationId) },
      { $set: { status } }
    );
    res.json(result);
  });

  // Update club
  app.put("/manager/my-clubs/:id", verifyToken, async (req, res) => {
    const clubId = req.params.id;
    const updateData = req.body;

    const club = await clubCollection.findOne({ _id: new ObjectId(clubId) });
    if (!club) return res.status(404).send("Club not found");
    if (req.decoded.email !== club.managerEmail)
      return res.status(403).send("Forbidden");

    const result = await clubCollection.updateOne(
      { _id: new ObjectId(clubId) },
      { $set: updateData }
    );

    res.json(result);
  });

  // Test
  await client.db("admin").command({ ping: 1 });
  console.log("Connected to MongoDB successfully!");
}

run();

app.get("/", (req, res) => res.send("My ClubSphere server is running..."));
app.listen(port, () => console.log(`Server running on port ${port}`));
