const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

let mongoClient = null;
let connectPromise = null;

/**
 * Returns a shared, connected MongoClient for the lifetime of the process.
 * Do not call .close() per request — use closeMongo() only for scripts/tests.
 */
const connectToMongo = async () => {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
    });
  }

  if (!connectPromise) {
    connectPromise = mongoClient.connect().then(() => {
      console.log("MongoDB connected");
      return mongoClient;
    });
  }

  return connectPromise;
};

const closeMongo = async () => {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    connectPromise = null;
    console.log("MongoDB connection closed");
  }
};

module.exports = { connectToMongo, closeMongo };
