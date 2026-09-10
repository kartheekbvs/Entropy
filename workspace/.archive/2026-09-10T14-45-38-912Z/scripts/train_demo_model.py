#!/usr/bin/env python3
"""
TrainDemoModel — Trains a spam classifier on synthetic data and saves it as .pkl.

Usage:
    python3 train_demo_model.py

Outputs:
    demo_models/spam_classifier.pkl
    demo_models/spam_classifier.meta.json  (optional metadata)
"""
import os
import json
import numpy as np
import joblib
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline

# ── Synthetic training data ────────────────────────────────────────────────────
HAM_TRAIN = [
    "Hello, how are you doing today?",
    "Can you send me the report by Friday?",
    "Meeting at 3pm in conference room B.",
    "Thanks for your help with the project.",
    "Please review the attached document.",
    "Let me know if you have any questions.",
    "Looking forward to our call tomorrow.",
    "The files have been uploaded to the shared drive.",
    "Could you please confirm your attendance?",
    "Great work on the presentation!",
    "I will be out of office next week.",
    "Please find the invoice attached.",
    "The server maintenance is scheduled for Saturday.",
    "Your subscription has been renewed successfully.",
    "The team meeting notes are in your email.",
    "Looking forward to hearing from you soon.",
    "We have scheduled the interview for next Tuesday.",
    "Your order has been shipped and should arrive within 3 days.",
    "Please review the budget proposal when you have time.",
    "The project deadline has been extended to next month.",
    "I attached the quarterly report for your review.",
    "Can we reschedule our meeting to Thursday?",
    "Thank you for your feedback on the proposal.",
    "The new policy will take effect from January 1st.",
    "Please update your contact information in the system.",
    "The server upgrade has been completed successfully.",
    "I have forwarded your email to the relevant team.",
    "Our quarterly earnings exceeded expectations this year.",
    "Please confirm your availability for next week's training.",
    "The client has approved the final design mockups.",
    "I will send the revised version by end of day.",
    "The system is back online after the scheduled maintenance.",
    "Could you please clarify the requirements in the email?",
    "Your leave request has been approved by management.",
    "We are planning a team outing next month.",
    "The latest software update includes security patches.",
    "I am attaching the meeting agenda for tomorrow.",
    "Please ensure all team members review the new guidelines.",
    "The product launch is scheduled for March 15th.",
    "Your performance review is scheduled for next Monday.",
    "The code review has been completed with minor suggestions.",
    "Please join the video call using the link in your calendar.",
    "The expense report has been processed and approved.",
    "I need your approval to proceed with the purchase.",
    "The latest market analysis is available in the shared folder.",
    "We have updated our privacy policy, please review it.",
    "The prototype testing results look very promising.",
    "I have scheduled a demo for the new features.",
    "Please coordinate with the design team for the new assets.",
    "The annual company event will be held in June.",
]

SPAM_TRAIN = [
    "CONGRATULATIONS! You have won a FREE iPhone! Click here now!",
    "URGENT: Your account has been compromised. Verify your details immediately!",
    "You have been selected for a FREE lottery prize of $5,000,000. Claim now!",
    "Buy cheap VIAGRA online — 80% OFF with free shipping!",
    "Earn $500 per day working from home! No experience needed. Click here!",
    "Your email has won $1,000,000 in our international lottery! Act now!",
    "HOT SINGLES in your area want to meet you! Click NOW!",
    "FREE gift card worth $500 just for completing a short survey!",
    "Your computer may be infected! Download our antivirus NOW — FREE!",
    "LOWEST mortgage rates available! Refinance your home today!",
    "CRITICAL SECURITY ALERT: Someone tried to access your account from Russia!",
    "You are pre-approved for a $50,000 personal loan at 0% interest!",
    "LIMITED TIME OFFER: Enlarge your... Guaranteed results or money back!",
    "Congratulations! Your number was randomly selected as our winner of $1,000,000!",
    "Instant weight loss! Lose 30 pounds in 30 days. No exercise needed!",
    "Your Netflix account has been suspended. Update payment info to continue.",
    "MAKE MONEY FAST! Secret system earns $10,000 per week from home!",
    "YOUR BANK ACCOUNT HAS BEEN FROZEN. Verify your identity now to unfreeze!",
    "FREE iPad when you sign up for our premium membership today!",
    "You have an unclaimed reward waiting. Expires in 24 hours! Claim NOW!",
    "Double your money in 30 days with our guaranteed investment program!",
    "Your Amazon order could not be delivered. Update your shipping address!",
    "EXCLUSIVE DEAL: Get prescription glasses without a prescription! 70% off!",
    "BITCOIN GENERATOR: Generate 1 BTC per day free! No catch!",
    "Your Microsoft account password expires in 24 hours. Reset now!",
    "JOB OFFER: Work 2 hours a day and earn $8,000 monthly from home!",
    "WARNING: Viruses found on your computer! Download our cleaner immediately!",
    "You have been charged $499.99 for our premium service. Call to cancel!",
    "FREE vacation to Hawaii! Complete one quick survey to claim!",
    "Your car warranty has expired. Renew it now at a discounted rate!",
    "DEADLINE TODAY: Claim your $5,000 gift card before midnight!",
    "Millionaire secrets revealed! Learn how they made their fortune!",
    "Your device is running out of memory! Free up space with our tool!",
    "Congratulations! You are our 1 millionth visitor! Claim your prize!",
    "SIDE INCOME: $200/day posting ads on Facebook from your couch!",
    "ACCOUNT SUSPENDED: We detected suspicious activity on your PayPal!",
    "FREE cell phone upgrade — just pay shipping and handling!",
    "Learn how to quit your job and travel the world full-time!",
    "Your Social Security number has been flagged for fraud. Call us NOW!",
    "SPECIAL OFFER: Discounted luxury watches — 90% off retail price!",
    "REFERRAL BONUS: Invite 5 friends and earn $500 each!",
    "URGENT: Your package from FedEx is waiting. Pay the small fee to release!",
    "Get rich quick with our proven cryptocurrency trading system!",
    "FREE dental implants consultation — limited time offer!",
    "Your WiFi router may be hacked! Secure your network with our app!",
    "Congratulations! Your name was drawn in our $2,000 sweepstakes!",
    "Amazing opportunity: Part-time job paying $800/day. No experience required!",
    "Your computer is missing critical updates! Download now to stay safe!",
    "One-time offer: Enroll in our program and change your life forever!",
    "INTERNATIONAL LOTTERY: You have won 7.5 million euros! Claim your prize!",
]

# ── Test data (for verifying the model) ──────────────────────────────────────
HAM_TEST = [
    "Hi, please let me know if the proposal looks good.",
    "Can we schedule a call for next week?",
    "Thanks for sending the invoice.",
    "The presentation went really well, the team loved it.",
    "Please review the code changes on GitHub.",
]

SPAM_TEST = [
    "FREE MONEY! Click here to claim your $10,000 prize NOW!",
    "URGENT: Your account needs verification. Do it immediately!",
    "You have been selected for a special offer!",
    "Congratulations! You are our lucky winner today!",
    "Your device may be infected. Download our security tool now!",
]


def train_spam_classifier():
    """Train a TF-IDF + Naive Bayes spam classifier and save as .pkl."""
    # Combine training data
    texts = HAM_TRAIN + SPAM_TRAIN
    labels = [0] * len(HAM_TRAIN) + [1] * len(SPAM_TRAIN)

    # Shuffle
    indices = np.arange(len(texts))
    np.random.seed(42)
    np.random.shuffle(indices)
    texts = [texts[i] for i in indices]
    labels = [labels[i] for i in indices]

    # Build pipeline
    pipeline = Pipeline([
        ('tfidf', TfidfVectorizer(
            max_features=5000,
            ngram_range=(1, 2),
            stop_words='english',
            min_df=1,
            max_df=0.95,
        )),
        ('clf', MultinomialNB(alpha=0.1)),
    ])

    # Train
    print("Training spam classifier...")
    pipeline.fit(texts, labels)

    # Evaluate on training set
    train_acc = pipeline.score(texts, labels)
    print(f"Training accuracy: {train_acc:.4f}")

    # Quick test predictions
    print("\nSample predictions:")
    test_texts = HAM_TEST + SPAM_TEST
    test_expected = [0]*len(HAM_TEST) + [1]*len(SPAM_TEST)
    preds = pipeline.predict(test_texts)
    for text, pred, expected in zip(test_texts, preds, test_expected):
        label = "SPAM" if pred == 1 else "HAM"
        correct = "✓" if pred == expected else "✗"
        print(f"  {correct} [{label}] {text[:60]}")

    # Save
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'demo_models')
    os.makedirs(output_dir, exist_ok=True)

    model_path = os.path.join(output_dir, 'spam_classifier.pkl')
    joblib.dump(pipeline, model_path)
    print(f"\nModel saved to: {model_path}")
    print(f"File size: {os.path.getsize(model_path):,} bytes")

    # Save metadata
    meta = {
        'name': 'Spam Classifier',
        'version': '1.0.0',
        'task_type': 'classification',
        'class_labels': ['HAM', 'SPAM'],
        'feature_count': 5000,
        'algorithm': 'TF-IDF + Multinomial Naive Bayes',
        'accuracy': round(train_acc, 4),
        'training_samples': len(texts),
        'input_example': 'List of text strings, e.g. ["Hello world", "FREE MONEY CLICK HERE"]',
        'output_example': {'prediction': 'SPAM', 'raw': [1], 'task_type': 'classification'},
    }

    meta_path = os.path.join(output_dir, 'spam_classifier.meta.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)
    print(f"Metadata saved to: {meta_path}")

    return pipeline, model_path


if __name__ == '__main__':
    train_spam_classifier()
    print("\nDone! You can now upload the .pkl file to ModelForge at /upload.html")
