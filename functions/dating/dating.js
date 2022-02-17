const functions = require('firebase-functions')
const admin = require('firebase-admin')

const firestore = admin.firestore
const db = admin.firestore()

const usersRef = db.collection('users')
const swipesRef = db.collection('user_swipes')
const matchesRef = db.collection('matches')

const checkIfMatchExist = async swipe => {
  const { swipedProfileID, authorID, type } = swipe
  const otherUserSwipeSnapshot = await swipesRef
    .doc(swipedProfileID)
    .collection(`${type}s`)
    .doc(authorID)
    .get()
  if (!otherUserSwipeSnapshot.exists) {
    return false
  }
  const otherUserSwipe = otherUserSwipeSnapshot.data()

  return otherUserSwipe.type === type
}

const writeMatchesCollection = async (author, matchedUser) => {
  if (!author || !matchedUser) {
    return
  }

  const batch = db.batch()

  const authorMatchedRef = matchesRef
    .doc(author.id)
    .collection('my_matches')
    .doc(matchedUser.id)
  const matchedUserRef = matchesRef
    .doc(matchedUser.id)
    .collection('my_matches')
    .doc(author.id)

  batch.set(authorMatchedRef, matchedUser)
  batch.set(matchedUserRef, author)
  batch.commit()
}

const writeSwipesCollection = swipe => {
  const mySwipeRef = swipesRef.doc(swipe.authorID)
  return mySwipeRef
    .collection(`${swipe.type}s`)
    .doc(swipe.swipedProfileID)
    .set(swipe)
}

const fetchUserData = async userID => {
  const userSnapshot = await usersRef.doc(userID).get()
  return userSnapshot.data()
}

exports.addUserSwipe = functions.https.onCall(async (data, context) => {
  const { swipedProfileID, authorID, type } = data

  let matchedUserData = null

  try {
    if (type === 'like' || type === 'superlike') {
      const ifMatchExist = await checkIfMatchExist(data)

      if (ifMatchExist) {
        const author = await fetchUserData(authorID)
        matchedUserData = await fetchUserData(swipedProfileID)
        writeMatchesCollection(author, matchedUserData)
      }
    }

    writeSwipesCollection(data)
    return matchedUserData
  } catch (error) {
    console.log('\n\n addUserSwipe: ', error)
    return matchedUserData
  }
})
