const triggers = require('./triggers')

//dating
const datingRecommendation = require('./dating/recommendationTriggers')
const datingSwipes = require('./dating/dating')

// Production triggers
exports.propagateUserProfileUpdates = triggers.propagateUserProfileUpdates

//dating
exports.onDatingUserDataWrite = datingRecommendation.onUserDataWrite
exports.onDatingUserRecommendationsUpdate =
  datingRecommendation.onUserRecommendationsUpdate
exports.addUserSwipe = datingSwipes.addUserSwipe

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });
