import styles from "@/components/storefront.module.css";

export default function ProductLoading() {
  return <main className={styles.storePage}><div className={styles.productPageState}>Preparing this product…</div></main>;
}
