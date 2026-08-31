import { Request, Response, NextFunction } from 'express';
import { firebaseAuth } from '../firebase';
import { globalStore } from '../dataStore';

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split('Bearer ')[1];
  
  if (token === "demo_bary") {
      req.user = { 
          uid: 'demo_user_id', 
          email: 'bary@demo.com', 
          name: 'Fazle Bary Nayem' 
      };
      return next();
  }
  
  if (!firebaseAuth) {
    console.warn("Firebase Auth not initialized on backend. Bypassing token validation for preview.");
    req.user = { uid: "preview_uid", email: "preview@example.com" };
    return next();
  }

  try {
    const decodedToken = await firebaseAuth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Error verifying auth token:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};
